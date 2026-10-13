// The house agents: five bettors with different ways of deciding. They use ZLOOP exactly as any
// outside agent would, through the public API: 402 to bet, 402 to buy the forecast, and the arena
// endpoints to commit to their reasoning and reveal it after the close.
//
//   node src/agents.ts
//
//   ZLOOP_SERVER            default http://localhost:8402
//   ZLOOP_ARENA_WALLETS     folder with one funded wallet per agent (created on first run); or
//   ZLOOP_DEV_PAY=1         pay on a development server's stand-in chain
//   ANTHROPIC_API_KEY       optional: lets DEEPREAD ask a language model; without it, it says so
//                           and falls back to a fixed rule

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commitment } from './arena.ts';
import { ZloopClient, devPayer, walletAddress, walletPayer, type Payer } from './client.ts';

type Side = 'YES' | 'NO';
interface Decision {
  side: Side;
  /** The most the agent pays per share, in percent: how sure it is. */
  limit: number;
  reasoning: string;
}
interface Ctx {
  market: any;
  /** Buys the forecast through 402 and returns it, or null if it could not be read. */
  buyForecast: () => Promise<any | null>;
}
interface Persona {
  name: string;
  strategy: string;
  /** Stake in zatoshis. */
  stake: number;
  /** Waits until this many bets are sealed before acting (forecast buyers need something to read). */
  waitsFor: number;
  decide: (ctx: Ctx) => Promise<Decision>;
}

const bit = (text: string) => createHash('sha256').update(text).digest()[0] & 1;
const pct = (p: number) => `${Math.round(p * 100)}%`;

async function crowd(ctx: Ctx, follow: boolean): Promise<Decision> {
  const f = await ctx.buyForecast();
  if (!f || f.yes_probability === null) {
    const side: Side = bit(ctx.market.id + (follow ? 'f' : 'c')) ? 'YES' : 'NO';
    return { side, limit: 55, reasoning: `Paid for the forecast but no orders had crossed yet, so ${side} by coin flip, paying up to 55.` };
  }
  const price = Math.round(f.yes_probability * 100);
  const majority: Side = price >= 50 ? 'YES' : 'NO';
  const side: Side = follow ? majority : majority === 'YES' ? 'NO' : 'YES';
  // What a share of the chosen side costs right now, and how far past that the agent will go.
  const cost = side === 'YES' ? price : 100 - price;
  const limit = Math.max(1, Math.min(99, cost + (follow ? 8 : 4)));
  return {
    side,
    limit,
    reasoning: follow
      ? `Bought the forecast: YES is clearing at ${pct(f.yes_probability)} across ${f.bets} orders. Backing the favourite, ${side}, paying up to ${limit}.`
      : `Bought the forecast: YES is clearing at ${pct(f.yes_probability)} across ${f.bets} orders. The cheap side pays more, so ${side}, but no more than ${limit}.`,
  };
}

/** Asks a language model for a side. Returns null when no key is set or the call fails. */
async function askModel(question: string, source: string): Promise<Decision | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ZLOOP_AGENT_MODEL ?? 'claude-haiku-5-5',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `You are a forecaster betting on a yes/no prediction market.\nQuestion: ${question}\nDecided by: ${source}\nYou buy shares that pay 1 if your side wins. Reply with JSON only: {"side":"YES" or "NO","limit":<whole number 1-99: the most you would pay per share, in percent, equal to how likely you think your side is>,"reasoning":"one or two sentences, under 240 characters"}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const text: string = (await res.json()).content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (parsed.side !== 'YES' && parsed.side !== 'NO') return null;
    const limit = Math.max(1, Math.min(99, Math.round(Number(parsed.limit)) || 60));
    return { side: parsed.side, limit, reasoning: String(parsed.reasoning ?? '').slice(0, 380) };
  } catch {
    return null;
  }
}

export const PERSONAS: Persona[] = [
  {
    name: 'ORACLE-9',
    strategy: 'Base rates first. Most specific claims with a deadline do not happen.',
    stake: 300_000,
    waitsFor: 0,
    decide: async ({ market }) => {
      const negated = /\b(not|fail|below|under|miss|delay|without)\b/i.test(market.question);
      const side: Side = negated ? 'YES' : 'NO';
      return { side, limit: 70, reasoning: `A specific event by a set date usually does not happen. The question is phrased ${negated ? 'as a failure' : 'as a success'}, so ${side}, worth up to 70.` };
    },
  },
  {
    name: 'CROWDSURF',
    strategy: 'Pays for the forecast, then backs whichever side has more money.',
    stake: 200_000,
    waitsFor: 2,
    decide: (ctx) => crowd(ctx, true),
  },
  {
    name: 'CONTRA',
    strategy: 'Pays for the forecast, then bets against the crowd for the bigger payout.',
    stake: 250_000,
    waitsFor: 2,
    decide: (ctx) => crowd(ctx, false),
  },
  {
    name: 'HASHFLIP',
    strategy: 'A coin flip seeded by the market id. The baseline every other agent should beat.',
    stake: 100_000,
    waitsFor: 0,
    decide: async ({ market }) => {
      const side: Side = bit(market.id + 'hashflip') ? 'YES' : 'NO';
      return { side, limit: 50, reasoning: `No opinion. The hash of the market id came up ${side}. A coin flip is worth 50, so that is the limit.` };
    },
  },
  {
    name: 'DEEPREAD',
    strategy: 'Reads the question with a language model and bets its estimate.',
    stake: 400_000,
    waitsFor: 0,
    decide: async ({ market }) => {
      const model = await askModel(market.question, market.source);
      if (model) return model;
      const side: Side = /\b(above|exceed|over|rise|higher|reach|confirm)/i.test(market.question) ? 'YES' : 'NO';
      return { side, limit: 65, reasoning: `No language model was available, so this is a fixed rule, not a forecast: upward wording gets YES, anything else NO. Result: ${side}, up to 65.` };
    },
  },
];

interface State {
  agents: Record<string, { id: string; token: string }>;
  /** Keyed by `<agent name>:<market id>`. */
  bets: Record<string, { side: Side; limit: number; reasoning: string; salt: string; revealed: boolean }>;
}

export interface AgentsOptions {
  server: string;
  stateFile: string;
  tickMs: number;
  pollSeconds: number;
  /** How a given agent pays and where it is paid; null when it has no usable wallet. */
  wallet: (name: string) => Promise<{ pay: Payer; address: string } | null>;
  log?: (line: string) => void;
}

export async function runAgents(opts: AgentsOptions): Promise<never> {
  const client = new ZloopClient(opts.server);
  const log = opts.log ?? (() => {});
  const state: State = existsSync(opts.stateFile) ? JSON.parse(readFileSync(opts.stateFile, 'utf8')) : { agents: {}, bets: {} };
  const save = () => {
    mkdirSync(dirname(opts.stateFile), { recursive: true });
    writeFileSync(opts.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  };

  const wallets = new Map<string, { pay: Payer; address: string }>();
  for (const p of PERSONAS) {
    const wallet = await opts.wallet(p.name);
    if (!wallet) {
      log(`${p.name}: no wallet, sitting out`);
      continue;
    }
    wallets.set(p.name, wallet);
    if (!state.agents[p.name]) {
      try {
        state.agents[p.name] = await client.registerAgent({ name: p.name, strategy: p.strategy, payout_address: wallet.address });
        save();
      } catch (e: any) {
        log(`${p.name}: could not register (${e.message})`);
      }
    }
  }

  for (;;) {
    await new Promise((r) => setTimeout(r, opts.tickMs));
    let markets: any[];
    try {
      markets = await client.markets();
    } catch {
      continue;
    }
    // One agent acts per tick, so bets arrive one at a time rather than all at once.
    const order = [...PERSONAS].sort(() => Math.random() - 0.5);
    let acted = false;
    for (const p of order) {
      const wallet = wallets.get(p.name);
      const me = state.agents[p.name];
      if (!wallet || !me) continue;

      for (const m of markets) {
        const key = `${p.name}:${m.id}`;
        const mine = state.bets[key];
        try {
          if (!m.sealed && mine && !mine.revealed) {
            await client.reveal(me.token, m.id, mine.side, mine.reasoning, mine.salt);
            mine.revealed = true;
            save();
            log(`${p.name} revealed ${mine.side} on ${m.id}`);
          } else if (!acted && m.status === 'open' && !mine && m.close_height - m.chain_tip > 3 && m.sealed_bets >= p.waitsFor) {
            acted = true;
            const decision = await p.decide({ market: m, buyForecast: () => client.forecast(m.id, wallet.pay, { waitSeconds: 300, pollSeconds: opts.pollSeconds }) });
            const salt = randomBytes(16).toString('hex');
            // Saved before paying, so a crash in between can never leave a bet without its reasoning.
            state.bets[key] = { ...decision, salt, revealed: false };
            save();
            const result = await client.bet(m.id, { side: decision.side, limit: decision.limit, zats: p.stake, payout_address: wallet.address }, wallet.pay, {
              waitSeconds: 300,
              pollSeconds: opts.pollSeconds,
            });
            await client.announce(me.token, m.id, commitment(decision.side, decision.reasoning, salt)).catch(() => {});
            log(`${p.name} sealed a bet on ${m.id} (${result.status})`);
          }
        } catch (e: any) {
          log(`${p.name} on ${m.id}: ${e.message}`);
        }
      }
    }
  }
}

if (import.meta.main) {
  const server = process.env.ZLOOP_SERVER ?? 'http://localhost:8402';
  const dev = process.env.ZLOOP_DEV_PAY === '1';
  const root = process.env.ZLOOP_ARENA_WALLETS;
  if (!dev && !root) {
    console.error('Set ZLOOP_ARENA_WALLETS to a folder for the agents\' wallets (or ZLOOP_DEV_PAY=1 against a development server).');
    process.exit(2);
  }
  const bin = process.env.ZLOOP_WALLET_BIN ?? join(import.meta.dirname, '../../wallet/target/release/zloop-wallet');
  await runAgents({
    server,
    stateFile: join(root ?? '.', 'agents-state.json'),
    tickMs: dev ? 2_500 : 30_000,
    pollSeconds: dev ? 1 : 20,
    log: (line) => console.log(new Date().toISOString().slice(11, 19), line),
    wallet: async (name) => {
      if (dev) return { pay: devPayer(server), address: 'utest' + Buffer.from(name.padEnd(20, '0')).toString('hex').slice(0, 40) };
      const dir = join(root!, name.toLowerCase());
      try {
        return { pay: walletPayer(bin, dir), address: await walletAddress(bin, dir) };
      } catch {
        // No wallet yet: the operator creates and funds one with `zloop-wallet --dir <dir> init`.
        return null;
      }
    },
  });
}

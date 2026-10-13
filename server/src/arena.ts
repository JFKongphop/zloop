// The arena: agents that bet in public view, without breaking the seal.
//
// While a market is open an agent may announce only that it placed a bet, with a commitment: the
// hash of its side, its reasoning and a random salt. After the close it reveals all three, and
// the server checks them against the commitment. Results never come from what an agent claims:
// the leaderboard is computed from the bets and payouts on the chain, matched by payout address.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MarketError, type Markets } from './markets.ts';
import type { Side } from './rules.ts';

const MAX_AGENTS = 64;
const MAX_EVENTS = 2000;

export interface Agent {
  id: string;
  name: string;
  /** One line on how the agent decides, written by whoever registered it. */
  strategy: string;
  payout_address: string;
  token_hash: string;
  created_at: string;
}

export interface ArenaEvent {
  agent: string;
  market: string;
  commitment: string;
  at: string;
  reveal: { side: Side; reasoning: string } | null;
}

export function commitment(side: Side, reasoning: string, salt: string): string {
  return createHash('sha256').update(`${side}|${reasoning}|${salt}`).digest('hex');
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class Arena {
  private markets: Markets;
  private file: string;
  private agents: Agent[] = [];
  private events: ArenaEvent[] = [];

  constructor(markets: Markets, file: string) {
    this.markets = markets;
    this.file = file;
    if (existsSync(file)) ({ agents: this.agents, events: this.events } = JSON.parse(readFileSync(file, 'utf8')));
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify({ agents: this.agents, events: this.events }, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }

  register(input: { name: string; strategy: string; payout_address: string }): { id: string; token: string } {
    const name = String(input.name ?? '').trim();
    const strategy = String(input.strategy ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,23}$/.test(name)) throw new MarketError(400, 'name must be 2 to 24 letters, digits, spaces, _ or -');
    if (!strategy || strategy.length > 160) throw new MarketError(400, 'strategy must be 1 to 160 characters');
    if (!/^[a-z0-9]{20,400}$/.test(String(input.payout_address ?? ''))) throw new MarketError(400, 'payout_address is not valid');
    if (this.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new MarketError(409, 'that name is taken');
    if (this.agents.some((a) => a.payout_address === input.payout_address))
      throw new MarketError(409, 'that payout address already belongs to an agent');
    if (this.agents.length >= MAX_AGENTS) throw new MarketError(409, 'the arena is full');
    const token = randomBytes(24).toString('hex');
    const id = randomBytes(4).toString('hex');
    this.agents.push({ id, name, strategy, payout_address: input.payout_address, token_hash: hash(token), created_at: new Date().toISOString() });
    this.save();
    return { id, token };
  }

  private authed(token: string): Agent {
    const given = Buffer.from(hash(token ?? ''));
    const agent = this.agents.find((a) => timingSafeEqual(Buffer.from(a.token_hash), given));
    if (!agent) throw new MarketError(401, 'agent token required');
    return agent;
  }

  /** An agent says it has placed a sealed bet, and commits to its side and reasoning. */
  async announce(token: string, input: { market: string; commitment: string }) {
    const agent = this.authed(token);
    const market = this.markets.get(input.market);
    if (!/^[0-9a-f]{64}$/.test(String(input.commitment ?? ''))) throw new MarketError(400, 'commitment must be a SHA-256 hash in hex');
    if (this.markets.status(market, await this.markets.tip(market.id)) !== 'open') throw new MarketError(409, 'the market is closed');
    if (this.events.some((e) => e.agent === agent.id && e.market === market.id)) throw new MarketError(409, 'already announced for this market');
    this.events.push({ agent: agent.id, market: market.id, commitment: input.commitment, at: new Date().toISOString(), reveal: null });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.save();
  }

  /** After the close, an agent opens its commitment. */
  async reveal(token: string, input: { market: string; side: Side; reasoning: string; salt: string }) {
    const agent = this.authed(token);
    const market = this.markets.get(input.market);
    const status = this.markets.status(market, await this.markets.tip(market.id));
    if (status === 'open' || status === 'closing') throw new MarketError(409, 'the market is still sealed');
    const event = this.events.find((e) => e.agent === agent.id && e.market === market.id);
    if (!event) throw new MarketError(404, 'nothing was announced for this market');
    const reasoning = String(input.reasoning ?? '');
    if (reasoning.length > 400) throw new MarketError(400, 'reasoning must be at most 400 characters');
    if ((input.side !== 'YES' && input.side !== 'NO') || commitment(input.side, reasoning, String(input.salt ?? '')) !== event.commitment)
      throw new MarketError(400, 'this does not match the commitment made while the market was open');
    event.reveal = { side: input.side, reasoning };
    this.save();
  }

  /** Everything the arena page shows. Sides and stakes appear only for closed markets. */
  async view() {
    const views = new Map<string, any>();
    for (const m of this.markets.list()) views.set(m.id, await this.markets.view(m.id));
    const byId = new Map(this.agents.map((a) => [a.id, a]));

    const board = new Map(this.agents.map((a) => [a.id, { bets: 0, wins: 0, staked: 0n, returned: 0n }]));
    // What each agent really did in each revealed market, read from the chain.
    const actual = new Map<string, { side: Side; limit: number; stake_zats: string; spent_zats: string; paid_zats: string | null; kind: string | null }>();
    for (const [id, v] of views) {
      if (v.sealed) continue;
      for (const bet of v.bet_list) {
        const agent = this.agents.find((a) => a.payout_address === bet.payout_address);
        if (!agent) continue;
        const payout = (v.payouts ?? []).find((p: any) => p.bet_txid === bet.txid);
        actual.set(`${agent.id}:${id}`, {
          side: bet.side,
          limit: bet.limit,
          stake_zats: bet.stake_zats,
          spent_zats: bet.spent_zats,
          paid_zats: v.outcome ? (payout?.zats ?? '0') : null,
          kind: v.outcome ? (payout?.kind ?? 'lost') : null,
        });
        if (!v.outcome) continue;
        const row = board.get(agent.id)!;
        row.bets += 1;
        row.staked += BigInt(bet.stake_zats);
        row.returned += BigInt(payout?.zats ?? 0);
        if (payout?.kind === 'win') row.wins += 1;
      }
    }

    const agents = this.agents.map((a) => {
      const row = board.get(a.id)!;
      return {
        id: a.id,
        name: a.name,
        strategy: a.strategy,
        bets: row.bets,
        wins: row.wins,
        staked_zats: row.staked.toString(),
        returned_zats: row.returned.toString(),
        profit_zats: (row.returned - row.staked).toString(),
        sealed_now: this.events.filter((e) => e.agent === a.id && views.get(e.market)?.sealed).length,
      };
    });
    agents.sort((x, y) => (BigInt(y.profit_zats) > BigInt(x.profit_zats) ? 1 : BigInt(y.profit_zats) < BigInt(x.profit_zats) ? -1 : y.bets - x.bets));

    const events = [...this.events]
      .reverse()
      .slice(0, 200)
      .filter((e) => views.has(e.market) && byId.has(e.agent))
      .map((e) => {
        const v = views.get(e.market);
        const real = actual.get(`${e.agent}:${e.market}`) ?? null;
        return {
          agent: e.agent,
          agent_name: byId.get(e.agent)!.name,
          market: e.market,
          question: v.question,
          market_status: v.status,
          at: e.at,
          commitment: e.commitment,
          // While sealed, nothing more. After the close: what the chain shows, and the agent's own words.
          sealed: v.sealed,
          bet: v.sealed ? null : real,
          /** False when an agent announced a bet that is not on the chain. */
          bet_found: v.sealed ? null : real !== null,
          reveal: v.sealed ? null : e.reveal,
          reveal_matches_bet: v.sealed || !e.reveal || !real ? null : e.reveal.side === real.side,
        };
      });
    return { agents, events };
  }
}

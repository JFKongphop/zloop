// What an agent needs to use ZLOOP: read markets, and place a bet through the 402 loop.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PaymentTerms {
  network: string;
  amount: string;
  payTo: string;
  extra: { memo: string; close_height: number; chain_tip: number };
}

/** Pays the terms of a 402 response and returns the transaction id. */
export type Payer = (terms: PaymentTerms) => Promise<string>;

export interface BetResult {
  status: 'accepted' | 'late' | 'pending';
  txid: string;
  receipt?: any;
  note?: string;
}

export class ZloopClient {
  private server: string;

  constructor(server: string) {
    this.server = server.replace(/\/$/, '');
  }

  async markets(): Promise<any[]> {
    return (await fetch(`${this.server}/markets`)).json();
  }

  async market(id: string): Promise<any> {
    const res = await fetch(`${this.server}/markets/${id}`);
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
    return res.json();
  }

  private bets(id: string, body: unknown, txid?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (txid) headers['payment-signature'] = Buffer.from(JSON.stringify({ txid })).toString('base64');
    return fetch(`${this.server}/markets/${id}/bets`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  /**
   * Buys the forecast of an open market: asks, gets "402 Payment Required", pays, then asks again
   * with the reference until the payment is mined. Returns null if it is not mined in time.
   */
  async forecast(id: string, pay: Payer, opts: { waitSeconds?: number; pollSeconds?: number } = {}): Promise<any | null> {
    const first = await fetch(`${this.server}/markets/${id}/forecast`);
    if (first.status !== 402) throw new Error((await first.json()).error ?? `expected 402, got HTTP ${first.status}`);
    const terms: PaymentTerms & { extra: { ref: string } } = (await first.json()).accepts[0];
    await pay(terms);
    const deadline = Date.now() + (opts.waitSeconds ?? 240) * 1000;
    const poll = (opts.pollSeconds ?? 20) * 1000;
    for (;;) {
      const res = await fetch(`${this.server}/markets/${id}/forecast?ref=${terms.extra.ref}`);
      if (res.status === 200) return res.json();
      if (res.status !== 402 || Date.now() + poll > deadline) return null;
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  async arena(): Promise<any> {
    return (await fetch(`${this.server}/arena`)).json();
  }

  private async arenaPost(path: string, body: unknown, token?: string): Promise<any> {
    const res = await fetch(`${this.server}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  registerAgent(agent: { name: string; strategy: string; payout_address: string }): Promise<{ id: string; token: string }> {
    return this.arenaPost('/arena/agents', agent);
  }

  announce(token: string, market: string, commitment: string): Promise<void> {
    return this.arenaPost('/arena/announce', { market, commitment }, token);
  }

  reveal(token: string, market: string, side: 'YES' | 'NO', reasoning: string, salt: string): Promise<void> {
    return this.arenaPost('/arena/reveal', { market, side, reasoning, salt }, token);
  }

  /** Whether a payment has been mined and counted as a bet. */
  async betStatus(id: string, txid: string): Promise<BetResult> {
    const res = await this.bets(id, {}, txid);
    if (res.status === 200) {
      const receipt = await res.json();
      return { status: receipt.status, txid, receipt };
    }
    return { status: 'pending', txid, note: 'not mined yet, or not a valid bet' };
  }

  /**
   * Places a bet: asks, gets "402 Payment Required", pays, then repeats the request with the
   * transaction id until the payment is mined or `waitSeconds` runs out.
   */
  async bet(
    id: string,
    bet: { side: 'YES' | 'NO'; limit: number; zats: number | bigint; payout_address: string },
    pay: Payer,
    opts: { waitSeconds?: number; pollSeconds?: number; onPaid?: (txid: string) => void } = {},
  ): Promise<BetResult> {
    const body = { side: bet.side, limit: bet.limit, zats: bet.zats.toString(), payout_address: bet.payout_address };
    const first = await this.bets(id, body);
    if (first.status !== 402) throw new Error((await first.json()).error ?? `expected 402, got HTTP ${first.status}`);
    const terms: PaymentTerms = (await first.json()).accepts[0];

    const txid = await pay(terms);
    opts.onPaid?.(txid);

    const deadline = Date.now() + (opts.waitSeconds ?? 240) * 1000;
    const poll = (opts.pollSeconds ?? 20) * 1000;
    for (;;) {
      const res = await this.bets(id, body, txid);
      if (res.status === 200) {
        const receipt = await res.json();
        return { status: receipt.status, txid, receipt };
      }
      // 409 here means the market closed while the payment was in flight; it will be refunded
      // once mined, so keep reporting it as pending.
      if (Date.now() + poll > deadline)
        return { status: 'pending', txid, note: 'paid; not mined yet. Check again with the transaction id.' };
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

/** Pays from a real wallet directory using the `zloop-wallet` program. */
export function walletPayer(bin: string, dir: string): Payer {
  const call = async (...args: string[]) => {
    try {
      return JSON.parse((await run(bin, ['--dir', dir, ...args], { maxBuffer: 64 << 20 })).stdout);
    } catch (e: any) {
      throw new Error(`wallet ${args[0]} failed: ${(e.stderr || e.message || '').trim()}`);
    }
  };
  return async (terms) => {
    await call('sync');
    return (await call('send', '--to', terms.payTo, '--zats', terms.amount, '--memo', terms.extra.memo)).txid;
  };
}

/** The wallet's own address, used as the default place to receive winnings. */
export async function walletAddress(bin: string, dir: string): Promise<string> {
  return JSON.parse((await run(bin, ['--dir', dir, 'info'])).stdout).address;
}

/** Pays on the server's stand-in chain. Works only when the server runs with ZLOOP_FAKE_WALLET=1. */
export function devPayer(server: string): Payer {
  return async (terms) => {
    const res = await fetch(`${server.replace(/\/$/, '')}/dev/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: terms.payTo, zats: terms.amount, memo: terms.extra.memo }),
    });
    if (!res.ok) throw new Error('this server is not on the stand-in chain; use a real wallet');
    return (await res.json()).txid;
  };
}

/** Builds the payer and payout address from the environment, shared by the agent and the MCP tool. */
export async function agentFromEnv(server: string): Promise<{ pay: Payer; address: string; mode: string }> {
  const dir = process.env.ZLOOP_AGENT_WALLET_DIR;
  if (dir) {
    const bin = process.env.ZLOOP_WALLET_BIN ?? new URL('../../wallet/target/release/zloop-wallet', import.meta.url).pathname;
    return { pay: walletPayer(bin, dir), address: await walletAddress(bin, dir), mode: 'wallet' };
  }
  if (process.env.ZLOOP_DEV_PAY === '1')
    return { pay: devPayer(server), address: 'utest' + 'demoagent'.padEnd(40, '0'), mode: 'stand-in chain' };
  throw new Error('Set ZLOOP_AGENT_WALLET_DIR to a funded wallet directory (or ZLOOP_DEV_PAY=1 against a development server).');
}

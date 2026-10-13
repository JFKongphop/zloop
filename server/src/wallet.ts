// How the server talks to shielded wallets. Each market has its own wallet, so its viewing key
// reveals that market and nothing else.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Payment } from './rules.ts';

const run = promisify(execFile);

export interface WalletInfo {
  network: string;
  address: string;
  viewing_key: string;
  viewing_key_fingerprint: string;
}

export interface SentPayment {
  txid: string;
  mined_height: number | null;
  to: string | null;
  zats: bigint;
  memo: string | null;
}

export interface Outgoing {
  to: string;
  zats: bigint;
  memo: string;
}

export interface WalletPort {
  readonly network: 'main' | 'test';
  /** Creates the wallet for a market. */
  create(id: string): Promise<WalletInfo>;
  /** Catches up with the chain and returns the tip height. */
  sync(id: string): Promise<number>;
  received(id: string): Promise<Payment[]>;
  sent(id: string): Promise<SentPayment[]>;
  /** Pays everyone in one transaction and returns its id. */
  pay(id: string, payments: Outgoing[]): Promise<string>;
  /** Whether the address can receive a shielded payment with a memo. */
  canPay(address: string): Promise<boolean>;
}

export function fingerprint(viewingKey: string): string {
  return createHash('sha256').update(viewingKey).digest('hex');
}

/** The real thing: runs the `zloop-wallet` program from `../wallet`. */
export class CliWallet implements WalletPort {
  readonly network: 'main' | 'test';
  private bin: string;
  private root: string;

  constructor(opts: { bin: string; root: string; network: 'main' | 'test' }) {
    this.bin = opts.bin;
    this.root = opts.root;
    this.network = opts.network;
  }

  private async call(dir: string, args: string[]): Promise<any> {
    try {
      const { stdout } = await run(this.bin, ['--dir', dir, ...args], { maxBuffer: 64 << 20 });
      return JSON.parse(stdout);
    } catch (e: any) {
      throw new Error(`wallet ${args[0]} failed: ${(e.stderr || e.message || '').trim()}`);
    }
  }

  private dir(id: string): string {
    return join(this.root, id);
  }

  create(id: string): Promise<WalletInfo> {
    return this.call(this.dir(id), ['init', '--network', this.network]);
  }

  async sync(id: string): Promise<number> {
    return (await this.call(this.dir(id), ['sync'])).chain_tip;
  }

  async received(id: string): Promise<Payment[]> {
    const rows = await this.call(this.dir(id), ['received']);
    return rows.map((r: any) => ({ ...r, zats: BigInt(r.zats) }));
  }

  async sent(id: string): Promise<SentPayment[]> {
    const rows = await this.call(this.dir(id), ['sent']);
    return rows.map((r: any) => ({ ...r, zats: BigInt(r.zats) }));
  }

  async pay(id: string, payments: Outgoing[]): Promise<string> {
    const json = JSON.stringify(payments.map((p) => ({ ...p, zats: Number(p.zats) })));
    return (await this.call(this.dir(id), ['pay', '--payments', json])).txid;
  }

  async canPay(address: string): Promise<boolean> {
    // Any wallet on the right network can answer; the check needs no keys.
    const any = join(this.root, '.check');
    try {
      return (await this.call(any, ['check', '--address', address])).accepts_memo;
    } catch {
      await this.call(any, ['init', '--network', this.network]);
      return (await this.call(any, ['check', '--address', address])).accepts_memo;
    }
  }
}

/**
 * A stand-in chain for tests and local development. Payments appear when `deposit` is called and
 * are mined when `mine` advances the tip. Nothing here touches Zcash.
 */
export class FakeWallet implements WalletPort {
  readonly network = 'test' as const;
  tip = 1000;
  private wallets = new Map<string, { info: WalletInfo; received: Payment[]; sent: SentPayment[] }>();

  async create(id: string): Promise<WalletInfo> {
    const viewing_key = 'uviewfake' + randomBytes(24).toString('hex');
    const info = {
      network: 'test',
      address: 'utestfake' + randomBytes(24).toString('hex'),
      viewing_key,
      viewing_key_fingerprint: fingerprint(viewing_key),
    };
    this.wallets.set(id, { info, received: [], sent: [] });
    return info;
  }

  private get(id: string) {
    const w = this.wallets.get(id);
    if (!w) throw new Error(`no wallet for ${id}`);
    return w;
  }

  /** A payment arrives in the next block. */
  deposit(id: string, zats: bigint, memo: string | null): string {
    const txid = randomBytes(32).toString('hex');
    this.get(id).received.push({ txid, mined_height: this.tip + 1, zats, memo });
    return txid;
  }

  /** Finds a market wallet by its address, the way a payer would. */
  depositTo(address: string, zats: bigint, memo: string | null): string {
    for (const [id, w] of this.wallets) if (w.info.address === address) return this.deposit(id, zats, memo);
    throw new Error(`no wallet with address ${address}`);
  }

  mine(blocks = 1): number {
    this.tip += blocks;
    return this.tip;
  }

  async sync(): Promise<number> {
    return this.tip;
  }

  async received(id: string): Promise<Payment[]> {
    return this.get(id).received.map((p) =>
      p.mined_height !== null && p.mined_height > this.tip ? { ...p, mined_height: null } : p,
    );
  }

  async sent(id: string): Promise<SentPayment[]> {
    return this.get(id).sent;
  }

  async pay(id: string, payments: Outgoing[]): Promise<string> {
    const w = this.get(id);
    const balance =
      w.received.filter((p) => p.mined_height !== null && p.mined_height <= this.tip).reduce((a, p) => a + p.zats, 0n) -
      w.sent.reduce((a, p) => a + p.zats, 0n);
    const total = payments.reduce((a, p) => a + p.zats, 0n);
    if (total > balance) throw new Error(`wallet pay failed: insufficient balance (have ${balance}, need ${total})`);
    const txid = randomBytes(32).toString('hex');
    for (const p of payments) w.sent.push({ txid, mined_height: this.tip + 1, to: p.to, zats: p.zats, memo: p.memo });
    return txid;
  }

  async canPay(address: string): Promise<boolean> {
    return /^(utest|ztestsapling|u1|zs)[a-z0-9]{20,}$/.test(address);
  }
}

// The life of a market: open, take bets, close, resolve, pay.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CLOSE_CONFIRMATIONS,
  FEE_RESERVE_ZATS,
  MIN_BET_ZATS,
  FORECAST_ACCESS_BLOCKS,
  FORECAST_PRICE_ZATS,
  betMemo,
  forecastMemo,
  parseBetMemo,
  readBets,
  readForecastPayments,
  settle,
  type Bet,
  type Outcome,
  type Side,
} from './rules.ts';
import { audit, type AuditReport } from './audit.ts';
import type { WalletPort } from './wallet.ts';

export interface Market {
  id: string;
  question: string;
  /** The public source that decides the outcome, named before any bet is placed. */
  source: string;
  network: 'main' | 'test';
  address: string;
  viewing_key_fingerprint: string;
  /** Kept private until the market closes. */
  viewing_key: string;
  open_height: number;
  close_height: number;
  outcome: Outcome | null;
  payout_txid: string | null;
  created_at: string;
}

export type Status = 'open' | 'closing' | 'closed' | 'resolved';

export class MarketError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How often a market's wallet may be synced; requests in between reuse the last result. */
const SYNC_INTERVAL_MS = 5_000;

export class Markets {
  private wallet: WalletPort;
  private file: string;
  private markets: Market[];
  private tips = new Map<string, { tip: number; at: number; pending?: Promise<number> }>();

  private syncIntervalMs: number;

  constructor(wallet: WalletPort, file: string, opts: { syncIntervalMs?: number } = {}) {
    this.wallet = wallet;
    this.file = file;
    this.syncIntervalMs = opts.syncIntervalMs ?? SYNC_INTERVAL_MS;
    this.markets = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.markets, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }

  get network(): 'main' | 'test' {
    return this.wallet.network;
  }

  list(): Market[] {
    return [...this.markets].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): Market {
    const market = this.markets.find((m) => m.id === id);
    if (!market) throw new MarketError(404, `no market ${id}`);
    return market;
  }

  /** Chain tip as the market's wallet sees it, synced at most every few seconds. */
  async tip(id: string, force = false): Promise<number> {
    const cached = this.tips.get(id);
    if (cached?.pending) return cached.pending;
    if (cached && !force && Date.now() - cached.at < this.syncIntervalMs) return cached.tip;
    const pending = this.wallet.sync(id).then(
      (tip) => {
        this.tips.set(id, { tip, at: Date.now() });
        return tip;
      },
      (e) => {
        this.tips.delete(id);
        throw e;
      },
    );
    this.tips.set(id, { tip: cached?.tip ?? 0, at: cached?.at ?? 0, pending });
    return pending;
  }

  status(market: Market, tip: number): Status {
    if (market.outcome) return 'resolved';
    if (tip < market.close_height) return 'open';
    return tip < market.close_height + CLOSE_CONFIRMATIONS ? 'closing' : 'closed';
  }

  async open(input: { question: string; source: string; close_in_blocks: number }): Promise<Market> {
    const question = input.question?.trim();
    const source = input.source?.trim();
    if (!question || !source) throw new MarketError(400, 'question and source are required');
    if (!Number.isInteger(input.close_in_blocks) || input.close_in_blocks < 1)
      throw new MarketError(400, 'close_in_blocks must be a positive whole number');

    const id = randomBytes(5).toString('hex');
    const info = await this.wallet.create(id);
    const tip = await this.tip(id, true);
    const market: Market = {
      id,
      question,
      source,
      network: this.wallet.network,
      address: info.address,
      viewing_key_fingerprint: info.viewing_key_fingerprint,
      viewing_key: info.viewing_key,
      open_height: tip,
      close_height: tip + input.close_in_blocks,
      outcome: null,
      payout_txid: null,
      created_at: new Date().toISOString(),
    };
    this.markets.push(market);
    this.save();
    return market;
  }

  /** What a bettor must pay, and the memo that makes the payment a bet. */
  async quote(id: string, input: { side: Side; limit: number; payout_address: string; zats: bigint }) {
    const market = this.get(id);
    if (input.side !== 'YES' && input.side !== 'NO') throw new MarketError(400, 'side must be YES or NO');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 99)
      throw new MarketError(400, 'limit must be a whole percentage from 1 to 99: the most you pay per share');
    if (input.zats < MIN_BET_ZATS) throw new MarketError(400, `the smallest order is ${MIN_BET_ZATS} zatoshis`);
    if (!(await this.wallet.canPay(input.payout_address ?? '')))
      throw new MarketError(400, 'payout_address must be a shielded address on this network');
    const tip = await this.tip(id);
    if (this.status(market, tip) !== 'open') throw new MarketError(409, 'the market is closed to new bets');
    const ref = randomBytes(8).toString('hex');
    return {
      market,
      tip,
      ref,
      memo: betMemo(market.id, input.side, input.limit, input.payout_address, ref),
      zats: input.zats,
    };
  }

  private async bets(market: Market): Promise<Bet[]> {
    const payments = await this.wallet.received(market.id);
    const payable = new Set<string>();
    for (const p of payments) {
      const memo = parseBetMemo(p.memo);
      if (memo && !payable.has(memo.payoutAddress) && (await this.wallet.canPay(memo.payoutAddress)))
        payable.add(memo.payoutAddress);
    }
    return readBets(payments, market.id, market.close_height, (a) => payable.has(a));
  }

  /** What a forecast buyer must pay. */
  async forecastQuote(id: string) {
    const market = this.get(id);
    const tip = await this.tip(id);
    if (this.status(market, tip) !== 'open') throw new MarketError(409, 'the market is closed; its result is public');
    const ref = randomBytes(8).toString('hex');
    return { market, tip, ref, memo: forecastMemo(market.id, ref), zats: FORECAST_PRICE_ZATS };
  }

  /**
   * The forecast of an open market, for someone who paid for it: the totals on each side, never
   * the individual bets. Returns null when no valid payment is found or its access has run out.
   */
  async forecast(id: string, by: { txid?: string; ref?: string }) {
    const market = this.get(id);
    const tip = await this.tip(id);
    const payments = await this.wallet.received(id);
    const paid = readForecastPayments(payments, id, market.close_height).find((f) =>
      by.txid ? f.txid === by.txid : f.ref === by.ref,
    );
    if (!paid || tip > paid.mined_height + FORECAST_ACCESS_BLOCKS) return null;
    const result = settle(await this.bets(market), 'VOID');
    return {
      market: id,
      as_of_height: tip,
      expires_height: paid.mined_height + FORECAST_ACCESS_BLOCKS,
      bets: result.bets.filter((b) => !b.late).length,
      stake_yes_zats: result.stake_yes.toString(),
      stake_no_zats: result.stake_no.toString(),
      // Where the market would clear if it closed now. Null while no YES and NO orders cross.
      indicative_price: result.clearing.price,
      matched_zats: result.clearing.matched.toString(),
      yes_probability: result.clearing.price === null ? null : result.clearing.price / 100,
    };
  }

  /** The bet made by a given transaction, or carrying a given reference, once it is mined. */
  async findBet(id: string, by: { txid?: string; ref?: string }): Promise<Bet | null> {
    const market = this.get(id);
    await this.tip(id);
    const bets = await this.bets(market);
    return bets.find((b) => (by.txid ? b.txid === by.txid : b.ref !== null && b.ref === by.ref)) ?? null;
  }

  /**
   * The audit as this server computes it, from its own wallet. It is a convenience for the page;
   * an independent check means running the audit tool with the published key.
   */
  async audit(id: string): Promise<AuditReport> {
    const market = this.get(id);
    const tip = await this.tip(id);
    if (this.status(market, tip) === 'open' || this.status(market, tip) === 'closing')
      throw new MarketError(409, 'the market is still sealed');
    const received = await this.wallet.received(id);
    const payable = new Set<string>();
    for (const p of received) {
      const memo = parseBetMemo(p.memo);
      if (memo && (await this.wallet.canPay(memo.payoutAddress))) payable.add(memo.payoutAddress);
    }
    return audit(market, { received, sent: await this.wallet.sent(id), canPay: (a) => payable.has(a) });
  }

  async resolve(id: string, outcome: Outcome): Promise<Market> {
    const market = this.get(id);
    if (!['YES', 'NO', 'VOID'].includes(outcome)) throw new MarketError(400, 'outcome must be YES, NO or VOID');
    if (market.outcome) throw new MarketError(409, 'the market is already resolved');
    const tip = await this.tip(id, true);
    if (this.status(market, tip) !== 'closed')
      throw new MarketError(409, `the market closes at height ${market.close_height + CLOSE_CONFIRMATIONS}; tip is ${tip}`);

    const forecasts = readForecastPayments(await this.wallet.received(id), id, market.close_height);
    const result = settle(await this.bets(market), outcome, forecasts);
    let txid: string | null = null;
    if (result.payouts.length) {
      try {
        txid = await this.wallet.pay(
          id,
          result.payouts.map((p) => ({ to: p.to, zats: p.zats, memo: p.memo })),
        );
      } catch (e: any) {
        // Freshly received funds need a few more blocks before they can be spent.
        throw new MarketError(503, `payouts could not be sent yet: ${e.message}`);
      }
    }
    market.outcome = outcome;
    market.payout_txid = txid;
    this.save();
    return market;
  }

  /** What the public may see. Totals and the viewing key appear only once the market is closed. */
  async view(id: string) {
    const market = this.get(id);
    const tip = await this.tip(id);
    const status = this.status(market, tip);
    const base = {
      id: market.id,
      question: market.question,
      source: market.source,
      network: market.network,
      status,
      address: market.address,
      viewing_key_fingerprint: market.viewing_key_fingerprint,
      open_height: market.open_height,
      close_height: market.close_height,
      chain_tip: tip,
      min_bet_zats: MIN_BET_ZATS.toString(),
      fee_reserve_zats: FEE_RESERVE_ZATS.toString(),
      created_at: market.created_at,
    };
    if (status === 'open' || status === 'closing') {
      // Only the number of bets is shown while sealed: never sides, stakes or addresses.
      const sealed_bets = (await this.bets(market)).filter((b) => !b.late).length;
      const forecast_sales = readForecastPayments(await this.wallet.received(id), id, market.close_height).length;
      return {
        ...base,
        sealed: true as const,
        sealed_bets,
        forecast_sales,
        forecast_price_zats: FORECAST_PRICE_ZATS.toString(),
      };
    }

    const forecasts = readForecastPayments(await this.wallet.received(id), id, market.close_height);
    const result = settle(await this.bets(market), market.outcome ?? 'VOID', forecasts);
    const fills = new Map(result.clearing.fills.map((f) => [f.bet_txid, f]));
    return {
      ...base,
      sealed: false as const,
      viewing_key: market.viewing_key,
      outcome: market.outcome,
      payout_txid: market.payout_txid,
      bets: result.bets.length,
      clearing_price: result.clearing.price,
      matched_zats: result.clearing.matched.toString(),
      bet_list: result.bets.map((b) => ({
        txid: b.txid,
        side: b.side,
        stake_zats: b.stake.toString(),
        mined_height: b.mined_height,
        limit: b.limit,
        spent_zats: (fills.get(b.txid)?.spent ?? 0n).toString(),
        shares_zats: (fills.get(b.txid)?.shares ?? 0n).toString(),
        payout_address: b.payout_address,
        late: b.late,
      })),
      stake_yes_zats: result.stake_yes.toString(),
      stake_no_zats: result.stake_no.toString(),
      pot_zats: result.pot.toString(),
      forecast_sales: result.forecast_sales,
      forecast_income_zats: result.forecast_income.toString(),
      // Before resolution these are what a VOID outcome would pay; they become final with the outcome.
      payouts: market.outcome ? result.payouts.map((p) => ({ ...p, zats: p.zats.toString() })) : null,
      refund_reason: market.outcome ? result.refund_reason : null,
    };
  }
}

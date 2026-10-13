// The rules of a ZLOOP market. The server and the audit tool both run this file, so an auditor
// recomputes the clearing price and every payout with exactly the code that produced them.
//
// A market is a sealed batch auction for two kinds of share. A YES share pays 1 if the answer is
// yes, a NO share pays 1 if it is no. An order says: "spend up to this budget on YES (or NO)
// shares, paying at most this price each". Orders are shielded payments whose memo carries the
// order, so nobody sees them until the close. Then all orders are opened at once and one price
// clears the market: a YES buyer at price p and a NO buyer at price 1 - p together fund one
// share each. The chain is the record; the server keeps no order book.

export type Side = 'YES' | 'NO';
export type Outcome = Side | 'VOID';

/** Smallest payment that counts as an order: 0.001 ZEC. Smaller payments stay in the wallet. */
export const MIN_BET_ZATS = 100_000n;

/**
 * Taken from every order to cover the network fee of the payout transaction. One transaction
 * pays everyone, and its fee is at most 5,000 zats per order plus 5,000, so 10,000 per order
 * covers it. Whatever is left stays in the market wallet, where the auditor can see it.
 */
export const FEE_RESERVE_ZATS = 10_000n;

/** What it costs to read an open market's indicative price: 0.0002 ZEC. */
export const FORECAST_PRICE_ZATS = 20_000n;

/** Held back from each forecast payment: spending it in the payout costs one more fee unit. */
export const FORECAST_FEE_RESERVE_ZATS = 5_000n;

/** How many blocks one forecast payment keeps the forecast readable. */
export const FORECAST_ACCESS_BLOCKS = 40;

/** Blocks to wait after the closing height before the viewing key is published. */
export const CLOSE_CONFIRMATIONS = 3;

export interface Payment {
  txid: string;
  mined_height: number | null;
  zats: bigint;
  memo: string | null;
}

export interface Bet {
  txid: string;
  mined_height: number;
  side: Side;
  /** What was paid. The budget for shares is this less the fee reserve. */
  stake: bigint;
  /** The most this order pays per share, as a whole percentage from 1 to 99. */
  limit: number;
  payout_address: string;
  /** A random reference chosen when the order was quoted; lets its owner look it up without a txid. */
  ref: string | null;
  late: boolean;
}

/** A payment that bought a look at the forecast. Its price, less the reserve, goes to the winners. */
export interface ForecastPayment {
  txid: string;
  mined_height: number;
  zats: bigint;
  ref: string;
}

/** What happened to one order at the clearing price. */
export interface Fill {
  bet_txid: string;
  /** Zatoshis of the budget that bought shares. */
  spent: bigint;
  /** Shares bought, in zatoshis of payout if the order's side wins. */
  shares: bigint;
  /** Budget that bought nothing and goes back: the price was past the limit, or the side was oversubscribed. */
  unspent: bigint;
}

export interface Clearing {
  /** The price of a YES share as a whole percentage, or null when no YES and NO orders cross. */
  price: number | null;
  /** Shares matched on each side, in zatoshis: the pot that the winning side receives. */
  matched: bigint;
  fills: Fill[];
}

export interface Payout {
  bet_txid: string;
  to: string;
  zats: bigint;
  memo: string;
  kind: 'win' | 'refund';
}

export interface Settlement {
  outcome: Outcome;
  bets: Bet[];
  clearing: Clearing;
  /** Total paid in by on-time orders. */
  pot: bigint;
  stake_yes: bigint;
  stake_no: bigint;
  reserve: bigint;
  /** Income from forecast sales, shared among the winners in proportion to their shares. */
  forecast_income: bigint;
  forecast_sales: number;
  payouts: Payout[];
  /** Why every order was refunded, when no shares changed hands or the market was void. */
  refund_reason: string | null;
}

export function betMemo(marketId: string, side: Side, limit: number, payoutAddress: string, ref?: string): string {
  return `zloop:v2:bet:${marketId}:${side}:${limit}:${payoutAddress}${ref ? ':' + ref : ''}`;
}

export function payoutMemo(kind: 'win' | 'refund', betTxid: string): string {
  return `zloop:v2:${kind === 'win' ? 'pay' : 'refund'}:${betTxid}`;
}

export function parseBetMemo(
  memo: string | null,
): { marketId: string; side: Side; limit: number; payoutAddress: string; ref: string | null } | null {
  const m = /^zloop:v2:bet:([a-z0-9-]{1,40}):(YES|NO):([1-9][0-9]?):([a-z0-9]{20,400})(?::([a-z0-9]{8,32}))?$/.exec(memo ?? '');
  return m ? { marketId: m[1], side: m[2] as Side, limit: Number(m[3]), payoutAddress: m[4], ref: m[5] ?? null } : null;
}

export function forecastMemo(marketId: string, ref: string): string {
  return `zloop:v2:peek:${marketId}:${ref}`;
}

export function parseForecastMemo(memo: string | null): { marketId: string; ref: string } | null {
  const m = /^zloop:v2:peek:([a-z0-9-]{1,40}):([a-z0-9]{8,32})$/.exec(memo ?? '');
  return m ? { marketId: m[1], ref: m[2] } : null;
}

/** Forecast payments that count: mined before the close, for this market, at least the price. */
export function readForecastPayments(payments: Payment[], marketId: string, closeHeight: number): ForecastPayment[] {
  const out: ForecastPayment[] = [];
  for (const p of payments) {
    if (p.mined_height === null || p.mined_height > closeHeight || p.zats < FORECAST_PRICE_ZATS) continue;
    const memo = parseForecastMemo(p.memo);
    if (memo && memo.marketId === marketId) out.push({ txid: p.txid, mined_height: p.mined_height, zats: p.zats, ref: memo.ref });
  }
  return out;
}

export function parsePayoutMemo(memo: string | null): { kind: 'win' | 'refund'; betTxid: string } | null {
  const m = /^zloop:v2:(pay|refund):([0-9a-f]{64})$/.exec(memo ?? '');
  return m ? { kind: m[1] === 'pay' ? 'win' : 'refund', betTxid: m[2] } : null;
}

/**
 * Which payments are orders. A payment counts when it is mined, is at least the minimum, and its
 * memo names this market, a side, a limit price, and an address that can be paid.
 * Orders mined after the closing height are kept, marked late, and refunded.
 */
export function readBets(
  payments: Payment[],
  marketId: string,
  closeHeight: number,
  canPay: (address: string) => boolean,
): Bet[] {
  const bets: Bet[] = [];
  for (const p of payments) {
    if (p.mined_height === null || p.zats < MIN_BET_ZATS) continue;
    const memo = parseBetMemo(p.memo);
    if (!memo || memo.marketId !== marketId || !canPay(memo.payoutAddress)) continue;
    bets.push({
      txid: p.txid,
      mined_height: p.mined_height,
      side: memo.side,
      stake: p.zats,
      limit: memo.limit,
      payout_address: memo.payoutAddress,
      ref: memo.ref,
      late: p.mined_height > closeHeight,
    });
  }
  return bets.sort((a, b) => a.mined_height - b.mined_height || a.txid.localeCompare(b.txid));
}

const budget = (b: Bet) => b.stake - FEE_RESERVE_ZATS;

/**
 * Finds the one price that clears the market.
 *
 * At a YES price of p percent, a YES order takes part if its limit is at least p, and a NO order
 * if its limit is at least 100 - p. The YES side then wants (its budget / p) shares and the NO
 * side (its budget / (100 - p)). The price chosen is the one that matches the most shares; ties
 * go to the smallest leftover demand, then the price nearest 50, then the lower price. The side
 * that wants fewer shares is filled in full, and the other is cut back in proportion.
 *
 * When every order would accept any price, this lands where the money on each side says the
 * odds are, which is what a plain betting pool would pay.
 */
export function clear(bets: Bet[]): Clearing {
  const onTime = bets.filter((b) => !b.late);
  const total = (side: Side, minLimit: number) =>
    onTime.filter((b) => b.side === side && b.limit >= minLimit).reduce((acc, b) => acc + budget(b), 0n);

  // Shares are compared as exact fractions (numerator over denominator), never as rounded numbers.
  let best: { p: number; yes: bigint; no: bigint; num: bigint; den: bigint; gapNum: bigint; gapDen: bigint } | null = null;
  for (let p = 1; p <= 99; p++) {
    const yes = total('YES', p);
    const no = total('NO', 100 - p);
    if (yes === 0n || no === 0n) continue;
    const P = BigInt(p);
    const N = BigInt(100 - p);
    const yesShort = yes * N <= no * P;
    const [num, den] = yesShort ? [yes, P] : [no, N];
    const cross = yes * N - no * P;
    const gapNum = cross < 0n ? -cross : cross;
    const gapDen = P * N;
    const better =
      !best ||
      num * best.den > best.num * den ||
      (num * best.den === best.num * den &&
        (gapNum * best.gapDen < best.gapNum * gapDen ||
          (gapNum * best.gapDen === best.gapNum * gapDen && Math.abs(p - 50) < Math.abs(best.p - 50))));
    if (better) best = { p, yes, no, num, den, gapNum, gapDen };
  }

  const untouched = (b: Bet): Fill => ({ bet_txid: b.txid, spent: 0n, shares: 0n, unspent: budget(b) });
  if (!best) return { price: null, matched: 0n, fills: onTime.map(untouched) };

  const price = best.p;
  const P = BigInt(price);
  const N = BigInt(100 - price);
  const { yes, no } = best;
  const yesShort = yes * N <= no * P;
  const fills = onTime.map((b): Fill => {
    const isYes = b.side === 'YES';
    if (isYes ? b.limit < price : b.limit < 100 - price) return untouched(b);
    const full = budget(b);
    // The side that wants more shares than the other can supply is scaled down, all orders alike.
    const spent = isYes ? (yesShort ? full : (full * no * P) / (yes * N)) : yesShort ? (full * yes * N) / (no * P) : full;
    const shares = (spent * 100n) / (isYes ? P : N);
    return { bet_txid: b.txid, spent, shares, unspent: full - spent };
  });
  const matched = fills.filter((_, i) => onTime[i].side === 'YES').reduce((acc, f) => acc + f.shares, 0n);
  return { price, matched, fills };
}

/**
 * Who gets paid what. Each order gets one payment at most: the value of its shares if its side
 * won, plus whatever part of its budget bought nothing. Winners also share the forecast income
 * in proportion to their shares. Everything is refunded when the market is void or no orders
 * crossed. Late orders are always refunded.
 */
export function settle(bets: Bet[], outcome: Outcome, forecasts: ForecastPayment[] = []): Settlement {
  const onTime = bets.filter((b) => !b.late);
  const sum = (list: Bet[]) => list.reduce((acc, b) => acc + b.stake, 0n);
  const stake_yes = sum(onTime.filter((b) => b.side === 'YES'));
  const stake_no = sum(onTime.filter((b) => b.side === 'NO'));
  const forecast_income = forecasts.reduce((acc, f) => acc + f.zats - FORECAST_FEE_RESERVE_ZATS, 0n);
  const clearing = clear(bets);
  const fillOf = new Map(clearing.fills.map((f) => [f.bet_txid, f]));

  let refund_reason: string | null = null;
  if (outcome === 'VOID') refund_reason = 'the market was declared void';
  else if (clearing.price === null && onTime.length) refund_reason = 'no YES and NO orders crossed';
  const refundAll = refund_reason !== null;

  const winningShares = refundAll ? 0n : clearing.fills.filter((_, i) => onTime[i].side === outcome).reduce((acc, f) => acc + f.shares, 0n);
  const payouts: Payout[] = [];
  for (const b of onTime) {
    const fill = fillOf.get(b.txid)!;
    const won = !refundAll && b.side === outcome && fill.shares > 0n;
    const zats = refundAll ? budget(b) : won ? fill.shares + fill.unspent + (forecast_income * fill.shares) / winningShares : fill.unspent;
    if (zats > 0n) payouts.push({ bet_txid: b.txid, to: b.payout_address, zats, memo: payoutMemo(won ? 'win' : 'refund', b.txid), kind: won ? 'win' : 'refund' });
  }
  for (const b of bets.filter((x) => x.late))
    payouts.push({ bet_txid: b.txid, to: b.payout_address, zats: budget(b), memo: payoutMemo('refund', b.txid), kind: 'refund' });

  return {
    outcome,
    bets,
    clearing,
    pot: stake_yes + stake_no,
    stake_yes,
    stake_no,
    reserve: FEE_RESERVE_ZATS * BigInt(onTime.length),
    forecast_income,
    forecast_sales: forecasts.length,
    payouts,
    refund_reason,
  };
}

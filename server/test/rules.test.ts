import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FEE_RESERVE_ZATS,
  FORECAST_FEE_RESERVE_ZATS,
  FORECAST_PRICE_ZATS,
  betMemo,
  clear,
  forecastMemo,
  parseBetMemo,
  parsePayoutMemo,
  payoutMemo,
  readBets,
  readForecastPayments,
  settle,
  type Bet,
  type Payment,
} from '../src/rules.ts';

const addr = (n: number) => 'utest' + String(n).padStart(30, 'a');
const txid = (n: number) => n.toString(16).padStart(64, '0');
/** An order whose budget for shares is exactly `budget` zatoshis. */
const bet = (n: number, side: 'YES' | 'NO', budget: bigint, limit: number, late = false): Bet => ({
  txid: txid(n),
  mined_height: 100 + n,
  side,
  stake: budget + FEE_RESERVE_ZATS,
  limit,
  payout_address: addr(n),
  ref: null,
  late,
});
const paid = (s: ReturnType<typeof settle>) => Object.fromEntries(s.payouts.map((p) => [parseInt(p.bet_txid, 16), [p.zats, p.kind]]));

test('an order memo round-trips', () => {
  const memo = betMemo('ab12cd34ef', 'YES', 62, addr(1));
  assert.deepEqual(parseBetMemo(memo), { marketId: 'ab12cd34ef', side: 'YES', limit: 62, payoutAddress: addr(1), ref: null });
  assert.equal(parseBetMemo(betMemo('ab12cd34ef', 'NO', 5, addr(1), '0123456789abcdef'))?.ref, '0123456789abcdef');
  for (const bad of ['hello', null, 'zloop:v2:bet:ab12:MAYBE:50:' + addr(1), 'zloop:v2:bet:ab12:YES:0:' + addr(1), 'zloop:v2:bet:ab12:YES:100:' + addr(1)])
    assert.equal(parseBetMemo(bad), null);
});

test('a payout memo round-trips', () => {
  assert.deepEqual(parsePayoutMemo(payoutMemo('win', txid(7))), { kind: 'win', betTxid: txid(7) });
  assert.deepEqual(parsePayoutMemo(payoutMemo('refund', txid(7))), { kind: 'refund', betTxid: txid(7) });
});

test('readBets keeps only mined, large enough, well-formed payments for this market', () => {
  const pay = (n: number, zats: bigint, memo: string | null, mined: number | null = 100): Payment => ({ txid: txid(n), mined_height: mined, zats, memo });
  const payments = [
    pay(1, 500_000n, betMemo('m1', 'YES', 60, addr(1))),
    pay(2, 500_000n, betMemo('m1', 'NO', 60, addr(2)), null), // not mined yet
    pay(3, 50_000n, betMemo('m1', 'NO', 60, addr(3))), // below the minimum
    pay(4, 500_000n, 'thanks'), // no order memo
    pay(5, 500_000n, betMemo('other', 'NO', 60, addr(5))), // another market
    pay(6, 500_000n, betMemo('m1', 'NO', 60, 'utestunpayable000000000000000000')), // address that cannot be paid
    pay(7, 500_000n, betMemo('m1', 'NO', 45, addr(7)), 201), // after the close
  ];
  const bets = readBets(payments, 'm1', 200, (a) => !a.includes('unpayable'));
  assert.deepEqual(bets.map((b) => [b.txid, b.side, b.limit, b.late]), [
    [txid(1), 'YES', 60, false],
    [txid(7), 'NO', 45, true],
  ]);
});

test('two orders that agree on a price are matched in full at that price', () => {
  // YES pays up to 60, NO pays up to 40: they meet at a YES price of 60.
  const c = clear([bet(1, 'YES', 600_000n, 60), bet(2, 'NO', 400_000n, 40)]);
  assert.equal(c.price, 60);
  assert.equal(c.matched, 1_000_000n);
  assert.deepEqual(c.fills.map((f) => [f.spent, f.shares, f.unspent]), [
    [600_000n, 1_000_000n, 0n],
    [400_000n, 1_000_000n, 0n],
  ]);
});

test('orders that accept any price clear where the money says the odds are', () => {
  // 3 on YES against 1 on NO with no real limits: the plain betting-pool price, 75.
  const c = clear([bet(1, 'YES', 3_000_000n, 99), bet(2, 'NO', 1_000_000n, 99)]);
  assert.equal(c.price, 75);
  assert.deepEqual(c.fills.map((f) => f.unspent), [0n, 0n]);
  const s = settle([bet(1, 'YES', 3_000_000n, 99), bet(2, 'NO', 1_000_000n, 99)], 'NO');
  assert.deepEqual(paid(s), { 2: [4_000_000n, 'win'] }, 'the long shot takes the whole pot');
});

test('orders that do not cross are refunded', () => {
  // YES pays at most 40, NO at most 40: together they offer only 80 for a share worth 100.
  const bets = [bet(1, 'YES', 500_000n, 40), bet(2, 'NO', 500_000n, 40)];
  assert.equal(clear(bets).price, null);
  const s = settle(bets, 'YES');
  assert.equal(s.refund_reason, 'no YES and NO orders crossed');
  assert.deepEqual(paid(s), { 1: [500_000n, 'refund'], 2: [500_000n, 'refund'] });
});

test('an order whose limit is past the clearing price buys nothing and gets its budget back', () => {
  const bets = [bet(1, 'YES', 600_000n, 60), bet(2, 'NO', 400_000n, 40), bet(3, 'YES', 900_000n, 30)];
  const c = clear(bets);
  assert.equal(c.price, 60);
  assert.deepEqual(c.fills[2], { bet_txid: txid(3), spent: 0n, shares: 0n, unspent: 900_000n });
  assert.deepEqual(paid(settle(bets, 'YES')), { 1: [1_000_000n, 'win'], 3: [900_000n, 'refund'] });
});

test('the oversubscribed side is cut back in proportion and the rest is returned', () => {
  // At 50, YES wants twice the shares NO can supply: each YES order is half filled.
  const bets = [bet(1, 'YES', 600_000n, 50), bet(2, 'YES', 200_000n, 50), bet(3, 'NO', 400_000n, 50)];
  const c = clear(bets);
  assert.equal(c.price, 50);
  assert.deepEqual(c.fills.map((f) => [f.spent, f.shares, f.unspent]), [
    [300_000n, 600_000n, 300_000n],
    [100_000n, 200_000n, 100_000n],
    [400_000n, 800_000n, 0n],
  ]);
  // YES wins: shares plus the unspent half. NO loses everything it spent.
  assert.deepEqual(paid(settle(bets, 'YES')), { 1: [900_000n, 'win'], 2: [300_000n, 'win'] });
  // NO wins: it takes the matched pot; the YES orders only get their unspent half back.
  assert.deepEqual(paid(settle(bets, 'NO')), { 1: [300_000n, 'refund'], 2: [100_000n, 'refund'], 3: [800_000n, 'win'] });
});

test('the price that matches the most shares wins', () => {
  // At 70 only the small NO order trades; at 55 the big one does too.
  const bets = [bet(1, 'YES', 1_100_000n, 80), bet(2, 'NO', 150_000n, 30), bet(3, 'NO', 900_000n, 45)];
  assert.equal(clear(bets).price, 55);
});

test('no payout ever exceeds what was paid in, whatever the orders', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let round = 0; round < 300; round++) {
    const bets = Array.from({ length: 2 + rnd(9) }, (_, i) => bet(i + 1, rnd(2) ? 'YES' : 'NO', BigInt(90_000 + rnd(5_000_000)), 1 + rnd(99)));
    for (const outcome of ['YES', 'NO', 'VOID'] as const) {
      const s = settle(bets, outcome);
      const out = s.payouts.reduce((a, p) => a + p.zats, 0n);
      // Rounding can leave the winners a few zatoshis over the matched money; the fee reserve covers it.
      assert.ok(out <= s.pot - s.reserve + BigInt(bets.length), `round ${round} ${outcome}: paid ${out} of ${s.pot - s.reserve}`);
      for (const f of s.clearing.fills) assert.ok(f.spent >= 0n && f.unspent >= 0n);
    }
  }
});

test('a void market refunds every order', () => {
  const s = settle([bet(1, 'YES', 600_000n, 60), bet(2, 'NO', 400_000n, 40)], 'VOID');
  assert.deepEqual(paid(s), { 1: [600_000n, 'refund'], 2: [400_000n, 'refund'] });
});

test('late orders are refunded and take no part in the clearing', () => {
  const bets = [bet(1, 'YES', 600_000n, 60), bet(2, 'NO', 400_000n, 40), bet(3, 'YES', 9_000_000n, 99, true)];
  const s = settle(bets, 'YES');
  assert.equal(s.clearing.price, 60);
  assert.deepEqual(paid(s), { 1: [1_000_000n, 'win'], 3: [9_000_000n, 'refund'] });
});

test('a market with no orders pays nothing', () => {
  assert.deepEqual(settle([], 'YES').payouts, []);
});

test('forecast payments count when mined before the close, for this market, at the full price', () => {
  const pay = (n: number, zats: bigint, memo: string, mined: number | null = 100): Payment => ({ txid: txid(n), mined_height: mined, zats, memo });
  const found = readForecastPayments(
    [
      pay(1, FORECAST_PRICE_ZATS, forecastMemo('m1', 'aaaaaaaaaaaaaaaa')),
      pay(2, FORECAST_PRICE_ZATS - 1n, forecastMemo('m1', 'bbbbbbbbbbbbbbbb')), // underpaid
      pay(3, FORECAST_PRICE_ZATS, forecastMemo('m2', 'cccccccccccccccc')), // another market
      pay(4, FORECAST_PRICE_ZATS, forecastMemo('m1', 'dddddddddddddddd'), 201), // after the close
      pay(5, FORECAST_PRICE_ZATS, forecastMemo('m1', 'eeeeeeeeeeeeeeee'), null), // not mined
    ],
    'm1',
    200,
  );
  assert.deepEqual(found.map((f) => f.ref), ['aaaaaaaaaaaaaaaa']);
});

test('forecast income is shared among the winners in proportion to their shares', () => {
  const bets = [bet(1, 'YES', 300_000n, 50), bet(2, 'YES', 100_000n, 50), bet(3, 'NO', 400_000n, 50)];
  const sale = { txid: txid(9), mined_height: 120, zats: FORECAST_PRICE_ZATS, ref: 'aaaaaaaaaaaaaaaa' };
  const income = 2n * (FORECAST_PRICE_ZATS - FORECAST_FEE_RESERVE_ZATS);
  const s = settle(bets, 'YES', [sale, { ...sale, txid: txid(10) }]);
  assert.equal(s.forecast_income, income);
  assert.deepEqual(paid(s), { 1: [600_000n + (income * 3n) / 4n, 'win'], 2: [200_000n + income / 4n, 'win'] });
});

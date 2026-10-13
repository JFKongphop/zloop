// The audit: given a closed market's published viewing key, recompute everything from the chain
// and compare it with what was paid.
//
//   node src/audit.ts <server url> <market id>
//   node src/audit.ts market.json
//
// It trusts nothing the server says except the terms published when the market opened: the
// fingerprint, the closing height and the outcome. Bets and payouts are read from the chain.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseBetMemo,
  parsePayoutMemo,
  readBets,
  readForecastPayments,
  settle,
  type Outcome,
  type Payment,
} from './rules.ts';
import { fingerprint, type SentPayment } from './wallet.ts';

export interface PublishedMarket {
  id: string;
  network: 'main' | 'test';
  viewing_key_fingerprint: string;
  viewing_key: string;
  open_height: number;
  close_height: number;
  outcome: Outcome | null;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AuditReport {
  ok: boolean;
  checks: Check[];
  bets: number;
  stake_yes_zats: string;
  stake_no_zats: string;
  pot_zats: string;
  forecast_income_zats: string;
  expected_payouts: { to: string; zats: string; kind: string; bet_txid: string }[];
}

const zec = (zats: bigint) => `${(Number(zats) / 1e8).toFixed(8)} ZEC`;

export function audit(
  market: PublishedMarket,
  chain: { received: Payment[]; sent: SentPayment[]; canPay: (address: string) => boolean },
): AuditReport {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const actual = fingerprint(market.viewing_key);
  check(
    'The viewing key is the one committed to at open',
    actual === market.viewing_key_fingerprint,
    actual === market.viewing_key_fingerprint ? `fingerprint ${actual.slice(0, 16)}…` : `expected ${market.viewing_key_fingerprint}, got ${actual}`,
  );

  const bets = readBets(chain.received, market.id, market.close_height, chain.canPay);
  const forecasts = readForecastPayments(chain.received, market.id, market.close_height);
  const result = settle(bets, market.outcome ?? 'VOID', forecasts);
  const report = {
    bets: bets.length,
    stake_yes_zats: result.stake_yes.toString(),
    stake_no_zats: result.stake_no.toString(),
    pot_zats: result.pot.toString(),
    forecast_income_zats: result.forecast_income.toString(),
    expected_payouts: result.payouts.map((p) => ({ to: p.to, zats: p.zats.toString(), kind: p.kind, bet_txid: p.bet_txid })),
  };

  if (!market.outcome) {
    check('The market is resolved', false, 'no outcome published yet; payouts cannot be checked');
    return { ok: false, checks, ...report };
  }

  const paid = chain.sent.filter((s) => parsePayoutMemo(s.memo));
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const expected of result.payouts) {
    const match = paid.filter((s) => s.memo === expected.memo);
    if (match.length === 0) missing.push(expected.bet_txid.slice(0, 12));
    else if (match.length > 1) wrong.push(`${expected.bet_txid.slice(0, 12)} was paid ${match.length} times`);
    else if (match[0].zats !== expected.zats)
      wrong.push(`${expected.bet_txid.slice(0, 12)} got ${zec(match[0].zats)}, should be ${zec(expected.zats)}`);
    else if (match[0].to !== null && match[0].to !== expected.to)
      wrong.push(`${expected.bet_txid.slice(0, 12)} was paid to a different address`);
  }
  const expectedMemos = new Set(result.payouts.map((p) => p.memo));
  const extra = paid.filter((s) => !expectedMemos.has(s.memo ?? ''));

  check(
    'Every payout that is owed was made',
    missing.length === 0,
    missing.length ? `missing for bets ${missing.join(', ')}` : `${result.payouts.length} of ${result.payouts.length}`,
  );
  check('Every payout has the right amount and address', wrong.length === 0, wrong.length ? wrong.join('; ') : 'all match');
  check(
    'Nothing was paid that is not owed',
    extra.length === 0,
    extra.length ? `${extra.length} payment(s) with no matching bet` : 'no extra payouts',
  );

  const unshown = paid.filter((s) => s.to === null).length;
  if (unshown) check('Payout addresses are visible to the auditor', false, `${unshown} payout(s) do not show their recipient`);

  const strays = chain.received.filter(
    (p) => p.mined_height !== null && !bets.some((b) => b.txid === p.txid) && !forecasts.some((f) => f.txid === p.txid),
  );
  if (strays.length)
    checks.push({
      name: 'Payments that are not bets',
      ok: true,
      detail: `${strays.length} payment(s) stay in the wallet: too small, no valid memo, or ${strays.some((p) => parseBetMemo(p.memo)) ? 'an address that cannot be paid' : 'not for this market'}`,
    });

  return { ok: checks.every((c) => c.ok), checks, ...report };
}

export function printReport(market: PublishedMarket, report: AuditReport) {
  console.log(`\nZLOOP audit of market ${market.id} (${market.network}net), outcome ${market.outcome ?? 'not resolved'}\n`);
  console.log(`  bets ${report.bets}   YES ${zec(BigInt(report.stake_yes_zats))}   NO ${zec(BigInt(report.stake_no_zats))}   pot ${zec(BigInt(report.pot_zats))}\n`);
  for (const c of report.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(`\n${report.ok ? 'AUDIT PASSED' : 'AUDIT FAILED'}\n`);
}

async function main() {
  const [a, b] = process.argv.slice(2);
  if (!a) {
    console.error('usage: node src/audit.ts <server url> <market id>   or   node src/audit.ts <market.json>');
    process.exit(2);
  }
  const market: PublishedMarket = b ? await (await fetch(`${a.replace(/\/$/, '')}/markets/${b}`)).json() : JSON.parse(readFileSync(a, 'utf8'));
  if (!market.viewing_key) {
    console.error('This market is still open: its viewing key is not published yet.');
    process.exit(2);
  }

  const bin = process.env.ZLOOP_WALLET_BIN ?? join(import.meta.dirname, '../../wallet/target/release/zloop-wallet');
  const dir = mkdtempSync(join(tmpdir(), 'zloop-audit-'));
  const run = promisify(execFile);
  const wallet = async (...args: string[]) => JSON.parse((await run(bin, ['--dir', dir, ...args], { maxBuffer: 64 << 20 })).stdout);
  try {
    await wallet('watch', '--network', market.network, '--viewing-key', market.viewing_key, '--birthday', String(market.open_height - 10));
    console.error('Scanning the chain with the published viewing key…');
    await wallet('sync');
    const toBig = (rows: any[]) => rows.map((r) => ({ ...r, zats: BigInt(r.zats) }));
    const received: Payment[] = toBig(await wallet('received'));
    const sent: SentPayment[] = toBig(await wallet('sent'));
    const payable = new Set<string>();
    for (const p of received) {
      const memo = parseBetMemo(p.memo);
      if (memo && (await wallet('check', '--address', memo.payoutAddress)).accepts_memo) payable.add(memo.payoutAddress);
    }
    const report = audit(market, { received, sent, canPay: (addr) => payable.has(addr) });
    printReport(market, report);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();

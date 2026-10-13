// A whole market over HTTP against the stand-in chain: open, bet through 402, close, resolve,
// then audit from the published viewing key.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Arena, commitment } from '../src/arena.ts';
import { audit } from '../src/audit.ts';
import { createApp } from '../src/http.ts';
import { Markets } from '../src/markets.ts';
import { CLOSE_CONFIRMATIONS } from '../src/rules.ts';
import { FakeWallet } from '../src/wallet.ts';

const chain = new FakeWallet();
const markets = new Markets(chain, join(mkdtempSync(join(tmpdir(), 'zloop-test-')), 'markets.json'), { syncIntervalMs: 0 });
const arena = new Arena(markets, join(mkdtempSync(join(tmpdir(), 'zloop-test-')), 'arena.json'));
const app = createApp(markets, { adminToken: 'secret', arena });
let base = '';

before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => app.close());

const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const alice = 'utest' + 'a'.repeat(40);
const bob = 'utest' + 'b'.repeat(40);

/** The whole 402 loop, as an agent would run it. */
async function placeBet(id: string, side: string, zats: number, payout_address: string, limit = 99) {
  const body = { side, limit, zats, payout_address };
  const first = await post(`/markets/${id}/bets`, body);
  assert.equal(first.status, 402);
  const fromHeader = JSON.parse(Buffer.from(first.headers.get('payment-required')!, 'base64').toString());
  const terms = (await first.json()).accepts[0];
  assert.deepEqual(fromHeader.accepts[0], terms);
  const txid = chain.depositTo(terms.payTo, BigInt(terms.amount), terms.extra.memo);
  const proof = { 'payment-signature': Buffer.from(JSON.stringify({ txid })).toString('base64') };

  const early = await post(`/markets/${id}/bets`, body, proof);
  assert.equal(early.status, 402, 'not mined yet');
  assert.equal((await early.json()).error, 'payment_not_found');

  assert.equal((await fetch(`${base}/markets/${id}/bets/${terms.extra.ref}`)).status, 404, 'the reference finds nothing before mining');
  chain.mine();
  const byRef = await fetch(`${base}/markets/${id}/bets/${terms.extra.ref}`);
  assert.equal(byRef.status, 200, 'the bettor can look the bet up by its private reference');
  assert.equal((await byRef.json()).txid, txid);
  assert.match(terms.extra.uri, /^zcash:utestfake[0-9a-f]+\?amount=[0-9.]+&memo=[A-Za-z0-9_-]+$/);
  const done = await post(`/markets/${id}/bets`, body, proof);
  assert.equal(done.status, 200);
  return { txid, receipt: await done.json() };
}

test('opening a market needs the admin token', async () => {
  const res = await post('/markets', { question: 'q', source: 's', close_in_blocks: 5 });
  assert.equal(res.status, 401);
});

test('a market runs from open to audited payout', async () => {
  const opened = await (await post('/markets', { question: 'Will it rain?', source: 'weather.example', close_in_blocks: 10 }, admin)).json();
  const id = opened.id;
  assert.equal(opened.status, 'open');
  assert.equal(opened.sealed, true);
  assert.equal(opened.viewing_key, undefined, 'the viewing key is private while the market is open');
  assert.match(opened.viewing_key_fingerprint, /^[0-9a-f]{64}$/);

  // Alice pays up to 80 for YES; Bob up to 30 for NO. They cross between 70 and 80.
  const a = await placeBet(id, 'YES', 3_010_000, alice, 80);
  assert.equal(a.receipt.status, 'accepted');
  assert.equal(a.receipt.side, 'YES');
  await placeBet(id, 'NO', 1_010_000, bob, 30);

  // The forecast is for sale: 402 first, then the totals once the payment is mined.
  const ask = await fetch(`${base}/markets/${id}/forecast`);
  assert.equal(ask.status, 402);
  const price = (await ask.json()).accepts[0];
  assert.equal(price.amount, '20000');
  chain.depositTo(price.payTo, BigInt(price.amount), price.extra.memo);
  assert.equal((await fetch(`${base}/markets/${id}/forecast?ref=${price.extra.ref}`)).status, 402, 'not mined yet');
  chain.mine();
  const forecast = await (await fetch(`${base}/markets/${id}/forecast?ref=${price.extra.ref}`)).json();
  assert.deepEqual([forecast.bets, forecast.indicative_price, forecast.matched_zats], [2, 75, '4000000']);
  assert.equal(forecast.payout_address, undefined, 'a forecast never shows individual bets');
  assert.equal((await fetch(`${base}/markets/${id}/forecast?ref=0000000000000000`)).status, 402, 'an unpaid reference buys nothing');

  const sealed = await (await fetch(`${base}/markets/${id}`)).json();
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.sealed_bets, 2, 'only the count of bets is visible while sealed');
  assert.equal((await fetch(`${base}/markets/${id}/audit`)).status, 409, 'no audit while sealed');
  for (const hidden of ['bets', 'pot_zats', 'stake_yes_zats', 'viewing_key']) assert.equal(sealed[hidden], undefined, `${hidden} is hidden while open`);

  const tooEarly = await post(`/markets/${id}/resolve`, { outcome: 'YES' }, admin);
  assert.equal(tooEarly.status, 409);

  chain.mine(opened.close_height - chain.tip + CLOSE_CONFIRMATIONS);
  const closedBet = await post(`/markets/${id}/bets`, { side: 'YES', limit: 50, zats: 1_000_000, payout_address: alice });
  assert.equal(closedBet.status, 409, 'no new bets after the close');

  const closed = await (await fetch(`${base}/markets/${id}`)).json();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.pot_zats, '4020000');
  assert.equal(closed.clearing_price, 75, 'one price for everyone');
  assert.ok(closed.viewing_key, 'the viewing key is published at close');

  const resolved = await (await post(`/markets/${id}/resolve`, { outcome: 'YES' }, admin)).json();
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(
    resolved.payouts.map((p: any) => [p.to, p.zats, p.kind]),
    [[alice, '4015000', 'win']], // 4,000,000 of matched shares plus 15,000 from the forecast sale
  );
  assert.equal((await post(`/markets/${id}/resolve`, { outcome: 'NO' }, admin)).status, 409, 'cannot resolve twice');

  // The auditor has only the published market and the chain.
  const chainView = { received: await chain.received(id), sent: await chain.sent(id), canPay: () => true };
  const report = audit(resolved, chainView);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  const served = await (await fetch(`${base}/markets/${id}/audit`)).json();
  assert.equal(served.ok, true);
  assert.equal(resolved.bet_list.length, 2);

  // A cheating operator: paying the winner less is caught.
  const short = chainView.sent.map((s) => ({ ...s, zats: s.zats - 1n }));
  assert.equal(audit(resolved, { ...chainView, sent: short }).ok, false);
  // So is swapping the viewing key.
  assert.equal(audit({ ...resolved, viewing_key: 'uviewfakeother' }, chainView).ok, false);
  // And so is paying someone who did not bet.
  const extra = [...chainView.sent, { ...chainView.sent[0], memo: 'zloop:v2:pay:' + 'f'.repeat(64) }];
  assert.equal(audit(resolved, { ...chainView, sent: extra }).ok, false);
});

test('bad bet requests are rejected before any payment', async () => {
  const { id } = await (await post('/markets', { question: 'q', source: 's', close_in_blocks: 10 }, admin)).json();
  const ok = { side: 'YES', limit: 50, zats: 1_000_000, payout_address: alice };
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, side: 'MAYBE' })).status, 400);
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, zats: 10 })).status, 400);
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, limit: 0 })).status, 400);
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, limit: 100 })).status, 400);
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, limit: undefined })).status, 400);
  assert.equal((await post(`/markets/${id}/bets`, { ...ok, payout_address: 't1transparent' })).status, 400);
  assert.equal((await post(`/markets/nope/bets`, ok)).status, 404);
});

test('an arena agent commits while sealed, reveals after the close, and is scored from the chain', async () => {
  const { id, close_height } = await (await post('/markets', { question: 'Arena?', source: 's', close_in_blocks: 10 }, admin)).json();
  const carol = 'utest' + 'c'.repeat(40);
  const reg = await post('/arena/agents', { name: 'CAROL-1', strategy: 'Always YES.', payout_address: carol });
  assert.equal(reg.status, 201);
  const { token } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await post('/arena/agents', { name: 'carol-1', strategy: 'x', payout_address: 'utest' + 'd'.repeat(40) })).status, 409, 'names are unique');

  await placeBet(id, 'YES', 1_000_000, carol);
  await placeBet(id, 'NO', 1_000_000, bob);
  const sealedCommit = commitment('YES', 'It always is.', 'salt-1');
  assert.equal((await post('/arena/announce', { market: id, commitment: sealedCommit })).status, 401, 'needs the agent token');
  assert.equal((await post('/arena/announce', { market: id, commitment: sealedCommit }, auth)).status, 200);
  assert.equal((await post('/arena/reveal', { market: id, side: 'YES', reasoning: 'It always is.', salt: 'salt-1' }, auth)).status, 409, 'no reveal while sealed');

  let view = await (await fetch(`${base}/arena`)).json();
  let event = view.events.find((e: any) => e.market === id);
  assert.deepEqual([event.agent_name, event.sealed, event.bet, event.reveal], ['CAROL-1', true, null, null], 'nothing but the commitment while sealed');

  chain.mine(close_height - chain.tip + CLOSE_CONFIRMATIONS);
  assert.equal((await post('/arena/reveal', { market: id, side: 'NO', reasoning: 'It always is.', salt: 'salt-1' }, auth)).status, 400, 'a changed story is rejected');
  assert.equal((await post('/arena/reveal', { market: id, side: 'YES', reasoning: 'It always is.', salt: 'salt-1' }, auth)).status, 200);
  await post(`/markets/${id}/resolve`, { outcome: 'YES' }, admin);

  view = await (await fetch(`${base}/arena`)).json();
  event = view.events.find((e: any) => e.market === id);
  assert.deepEqual([event.bet.side, event.bet.kind, event.reveal.reasoning, event.reveal_matches_bet], ['YES', 'win', 'It always is.', true]);
  const row = view.agents.find((a: any) => a.name === 'CAROL-1');
  assert.deepEqual([row.bets, row.wins, row.staked_zats, row.profit_zats], [1, 1, '1000000', '980000']); // both sides at 50: 990,000 buys 1,980,000 of shares
  assert.equal(JSON.stringify(view).includes(carol), false, 'payout addresses are not published by the arena');
});

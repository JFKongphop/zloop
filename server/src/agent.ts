// A demo agent. It finds an open market and places one bet through the 402 loop, printing each
// step. It follows a fixed rule, not a model: its job is to show the loop, not to forecast.
//
//   node src/agent.ts                       bet on the newest open market
//   node src/agent.ts <market id> YES 200000 60     side, budget in zatoshis, limit price in percent
//
//   ZLOOP_SERVER             default http://localhost:8402
//   ZLOOP_AGENT_WALLET_DIR   a funded wallet directory; or
//   ZLOOP_DEV_PAY=1          pay on a development server's stand-in chain

import { ZloopClient, agentFromEnv } from './client.ts';

const server = process.env.ZLOOP_SERVER ?? 'http://localhost:8402';
const client = new ZloopClient(server);
const [idArg, sideArg, zatsArg, limitArg] = process.argv.slice(2);
const step = (n: number, text: string) => console.log(`${n}. ${text}`);

const open = (await client.markets()).filter((m) => m.status === 'open');
const market = idArg ? await client.market(idArg) : open[0];
if (!market) {
  console.error('No open market. Open one first (see the README).');
  process.exit(1);
}
if (market.status !== 'open') {
  console.error(`Market ${market.id} is ${market.status}; it takes no new bets.`);
  process.exit(1);
}

// The rule: an explicit side wins; otherwise the last hex digit of the market id decides.
const side = sideArg === 'YES' || sideArg === 'NO' ? sideArg : parseInt(market.id.slice(-1), 16) % 2 ? 'YES' : 'NO';
const zats = Number(zatsArg ?? market.min_bet_zats);
// How sure the agent is: the most it will pay for a share that pays 1.
const limit = Number(limitArg ?? 60);
const agent = await agentFromEnv(server);

step(1, `Market ${market.id}: "${market.question}" (closes at block ${market.close_height}, tip ${market.chain_tip})`);
step(2, `Decision: ${side} shares, budget ${zats} zatoshis, paying at most ${limit}% each, from the ${agent.mode}`);
step(3, 'POST /bets → expecting 402 Payment Required');

const result = await client.bet(
  market.id,
  { side, limit, zats, payout_address: agent.address },
  async (terms) => {
    step(4, `402 received: pay ${terms.amount} zatoshis to ${terms.payTo.slice(0, 18)}… with memo ${terms.extra.memo.slice(0, 34)}…`);
    return agent.pay(terms);
  },
  { onPaid: (txid) => step(5, `Paid in transaction ${txid.slice(0, 16)}…; repeating the request until it is mined`), pollSeconds: agent.mode === 'wallet' ? 20 : 2 },
);

if (result.status === 'accepted') step(6, `200 OK: bet accepted at block ${result.receipt.mined_height}. It stays sealed until the market closes.`);
else if (result.status === 'late') step(6, 'The payment was mined after the close; it will be refunded.');
else step(6, `Still pending. Check later: transaction ${result.txid}`);

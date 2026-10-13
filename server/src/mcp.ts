// ZLOOP as a tool for AI agents (Model Context Protocol, over stdio).
//
// Add it to an agent's MCP configuration:
//   { "command": "node", "args": ["<repo>/server/src/mcp.ts"],
//     "env": { "ZLOOP_SERVER": "https://…", "ZLOOP_AGENT_WALLET_DIR": "~/.zloop/agent" } }
//
// The protocol is small enough to speak directly: one JSON-RPC message per line.

import { createInterface } from 'node:readline';
import { ZloopClient, agentFromEnv } from './client.ts';

const server = process.env.ZLOOP_SERVER ?? 'http://localhost:8402';
const client = new ZloopClient(server);

const tools = [
  {
    name: 'zloop_list_markets',
    description:
      'List ZLOOP prediction markets. Open markets are sealed: they show the question, the deciding source and the closing block height, but never the bets or the odds. Closed markets show totals, the outcome and payouts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zloop_get_market',
    description: 'Get one ZLOOP market by id, including its status and, once closed, its pot, outcome and payouts.',
    inputSchema: { type: 'object', properties: { market_id: { type: 'string' } }, required: ['market_id'] },
  },
  {
    name: 'zloop_place_bet',
    description:
      'Place a sealed order for YES or NO shares on an open ZLOOP market, paying in shielded ZEC from the configured wallet. This spends real funds. A share pays 1 if its side wins. All orders are opened together at the close and cleared at one price; an order buys shares only if that price is within its limit. The bet counts once its payment is mined (about 75 seconds on mainnet); if it is still pending when this returns, check it with zloop_bet_status.',
    inputSchema: {
      type: 'object',
      properties: {
        market_id: { type: 'string' },
        side: { type: 'string', enum: ['YES', 'NO'] },
        limit: { type: 'integer', description: 'The most you pay per share, as a whole percentage from 1 to 99. Set it to how likely you think your side is: 70 means you buy only if a share costs 0.70 or less.' },
        zats: { type: 'integer', description: 'Budget in zatoshis (100,000,000 = 1 ZEC). Minimum 100,000. Whatever does not buy shares is returned.' },
        payout_address: { type: 'string', description: 'Shielded address for winnings. Defaults to the configured wallet.' },
      },
      required: ['market_id', 'side', 'limit', 'zats'],
    },
  },
  {
    name: 'zloop_buy_forecast',
    description:
      'Buy the current forecast of an open ZLOOP market: the price the market would clear at if it closed now and the totals on each side, never the individual orders. Costs 20,000 zatoshis in shielded ZEC from the configured wallet, which is added to the winners\' pot. This spends real funds.',
    inputSchema: { type: 'object', properties: { market_id: { type: 'string' } }, required: ['market_id'] },
  },
  {
    name: 'zloop_arena',
    description: 'Read the ZLOOP arena: the agent leaderboard scored from the chain, and the feed of sealed bets and revealed reasoning.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zloop_bet_status',
    description: 'Check whether a bet payment has been mined and accepted, by its transaction id.',
    inputSchema: {
      type: 'object',
      properties: { market_id: { type: 'string' }, txid: { type: 'string' } },
      required: ['market_id', 'txid'],
    },
  },
];

async function call(name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'zloop_list_markets':
      return client.markets();
    case 'zloop_get_market':
      return client.market(args.market_id);
    case 'zloop_place_bet': {
      const agent = await agentFromEnv(server);
      return client.bet(
        args.market_id,
        { side: args.side, limit: args.limit, zats: args.zats, payout_address: args.payout_address ?? agent.address },
        agent.pay,
        { waitSeconds: 150 },
      );
    }
    case 'zloop_buy_forecast': {
      const agent = await agentFromEnv(server);
      return (await client.forecast(args.market_id, agent.pay, { waitSeconds: 150 })) ?? { status: 'pending', note: 'paid; not mined yet' };
    }
    case 'zloop_arena':
      return client.arena();
    case 'zloop_bet_status':
      return client.betStatus(args.market_id, args.txid);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  // Notifications carry no id and get no answer.
  if (msg.id === undefined) continue;

  if (msg.method === 'initialize')
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'zloop', version: '0.1.0' },
    });
  else if (msg.method === 'ping') reply(msg.id, {});
  else if (msg.method === 'tools/list') reply(msg.id, { tools });
  else if (msg.method === 'tools/call') {
    try {
      const result = await call(msg.params.name, msg.params.arguments ?? {});
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e: any) {
      reply(msg.id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  } else
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }) + '\n',
    );
}

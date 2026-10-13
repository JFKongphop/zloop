// Starts the market server.
//
//   ZLOOP_ADMIN_TOKEN   required; opens and resolves markets
//   ZLOOP_NETWORK       main (default) or test
//   ZLOOP_DATA_DIR      where market wallets and markets.json live; default ~/.zloop/server
//   ZLOOP_WALLET_BIN    path to zloop-wallet; default ../wallet/target/release/zloop-wallet
//   ZLOOP_FAKE_WALLET   set to 1 to run against a stand-in chain (no Zcash, for development)
//   PORT                default 8402

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAgents } from './agents.ts';
import { Arena } from './arena.ts';
import { devPayer } from './client.ts';
import { createApp } from './http.ts';
import { Markets } from './markets.ts';
import { CliWallet, FakeWallet, type WalletPort } from './wallet.ts';

const adminToken = process.env.ZLOOP_ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set ZLOOP_ADMIN_TOKEN to a long random value.');
  process.exit(2);
}

const here = import.meta.dirname;
const dataDir = process.env.ZLOOP_DATA_DIR ?? join(homedir(), '.zloop', 'server');
const fake = process.env.ZLOOP_FAKE_WALLET === '1';

let wallet: WalletPort;
let devPay: ((address: string, zats: bigint, memo: string | null) => string) | undefined;
if (fake) {
  const chain = new FakeWallet();
  // The stand-in chain mines a block every few seconds so markets move on their own.
  setInterval(() => chain.mine(), 3_000).unref();
  wallet = chain;
  devPay = (address, zats, memo) => chain.depositTo(address, zats, memo);
} else {
  const bin = process.env.ZLOOP_WALLET_BIN ?? join(here, '../../wallet/target/release/zloop-wallet');
  if (!existsSync(bin)) {
    console.error(`Wallet program not found at ${bin}. Build it: cd wallet && cargo build --release`);
    process.exit(2);
  }
  wallet = new CliWallet({ bin, root: join(dataDir, 'wallets'), network: process.env.ZLOOP_NETWORK === 'test' ? 'test' : 'main' });
}

const markets = new Markets(wallet, join(dataDir, fake ? 'markets.fake.json' : 'markets.json'), fake ? { syncIntervalMs: 0 } : {});
const arena = new Arena(markets, join(dataDir, fake ? 'arena.fake.json' : 'arena.json'));
const app = createApp(markets, { adminToken, arena, devPay, publicDir: join(here, '../public'), blockSeconds: fake ? 3 : 75 });

const port = Number(process.env.PORT ?? 8402);
app.listen(port, () => {
  console.log(`ZLOOP on http://localhost:${port} (${fake ? 'stand-in chain' : wallet.network + 'net'})`);
  // On the stand-in chain the house agents run inside the server, so the arena is alive at once.
  if (fake && process.env.ZLOOP_ARENA !== '0') {
    const server = `http://localhost:${port}`;
    runAgents({
      server,
      stateFile: join(dataDir, 'agents.fake.json'),
      tickMs: 2_500,
      pollSeconds: 1,
      wallet: async (name) => ({ pay: devPayer(server), address: 'utest' + Buffer.from(name.padEnd(20, '0')).toString('hex').slice(0, 40) }),
    }).catch((e) => console.error('agents stopped:', e.message));
  }
});

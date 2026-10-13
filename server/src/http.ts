// HTTP endpoints. Placing a bet follows the x402 pattern: the first request is answered with
// "402 Payment Required" and what to pay; the same request repeated with proof of payment
// returns the receipt.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Arena } from './arena.ts';
import { MarketError, type Markets } from './markets.ts';
import type { Bet, Outcome, Side } from './rules.ts';

/** The web app's files. Only these paths are served. */
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/views.js': { file: 'views.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/qrcode.js': { file: 'vendor/qrcode.js', type: 'text/javascript; charset=utf-8' },
};

/** A ZIP-321 payment link, which Zcash wallets can open or scan as a QR code. */
function paymentUri(address: string, zats: bigint, memo: string): string {
  const whole = zats / 100_000_000n;
  const frac = (zats % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const amount = frac ? `${whole}.${frac}` : `${whole}`;
  return `zcash:${address}?amount=${amount}&memo=${Buffer.from(memo).toString('base64url')}`;
}

function receipt(id: string, bet: Bet) {
  return {
    status: bet.late ? 'late' : 'accepted',
    market: id,
    txid: bet.txid,
    side: bet.side,
    stake_zats: bet.stake.toString(),
    mined_height: bet.mined_height,
    limit: bet.limit,
    payout_address: bet.payout_address,
    note: bet.late ? 'mined after the closing height; it will be refunded' : undefined,
  };
}

/** Seconds a client should wait before asking again whether its payment was mined. */
const RETRY_AFTER_SECONDS = 20;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) throw new MarketError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MarketError(400, 'request body must be JSON');
  }
}

/** The txid a client claims to have paid with, from the x402 payment header or the body. */
function paidTxid(req: IncomingMessage, body: any): string | null {
  const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
  let txid: unknown = body?.txid;
  if (typeof header === 'string') {
    try {
      const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      txid = payload?.payload?.txid ?? payload?.txid ?? txid;
    } catch {
      throw new MarketError(400, 'the payment header must be base64 JSON');
    }
  }
  if (txid === undefined || txid === null) return null;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) throw new MarketError(400, 'txid must be 64 hex characters');
  return txid;
}

export interface AppOptions {
  adminToken: string;
  arena?: Arena;
  /** Folder holding the web app. */
  publicDir?: string;
  /** Roughly how long a block takes, so the page can turn block counts into time. */
  blockSeconds?: number;
  /** Only on the stand-in chain: lets a client "pay" without Zcash. Never set against a real wallet. */
  devPay?: (address: string, zats: bigint, memo: string | null) => string;
}

export function createApp(markets: Markets, opts: AppOptions): Server {
  const isAdmin = (req: IncomingMessage) => {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(opts.adminToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS')
      return send(res, 204, null, {
        'access-control-allow-methods': 'GET,POST',
        'access-control-allow-headers': 'content-type,authorization,payment-signature,x-payment',
      });

    const asset = STATIC[url.pathname];
    if (method === 'GET' && asset && opts.publicDir && existsSync(join(opts.publicDir, asset.file))) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
      return res.end(readFileSync(join(opts.publicDir, asset.file)));
    }

    if (method === 'GET' && url.pathname === '/config')
      return send(res, 200, { network: markets.network, dev: Boolean(opts.devPay), block_seconds: opts.blockSeconds ?? 75 });

    if (method === 'POST' && url.pathname === '/admin/check') {
      if (!isAdmin(req)) throw new MarketError(401, 'admin token required');
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && url.pathname === '/dev/pay' && opts.devPay) {
      const body = await readJson(req);
      return send(res, 200, { txid: opts.devPay(body.address, BigInt(body.zats), body.memo ?? null) });
    }

    if (parts[0] === 'arena' && opts.arena) {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (method === 'GET' && parts.length === 1) return send(res, 200, await opts.arena.view());
      if (method === 'POST' && parts[1] === 'agents') return send(res, 201, opts.arena.register(await readJson(req)));
      if (method === 'POST' && parts[1] === 'announce') return send(res, 200, { ok: true, ...(await opts.arena.announce(bearer, await readJson(req))) });
      if (method === 'POST' && parts[1] === 'reveal') return send(res, 200, { ok: true, ...(await opts.arena.reveal(bearer, await readJson(req))) });
    }

    if (parts[0] !== 'markets') throw new MarketError(404, 'not found');

    if (method === 'GET' && parts.length === 1)
      return send(res, 200, await Promise.all(markets.list().map((m) => markets.view(m.id))));

    if (method === 'POST' && parts.length === 1) {
      if (!isAdmin(req)) throw new MarketError(401, 'admin token required');
      const body = await readJson(req);
      const market = await markets.open({
        question: body.question,
        source: body.source,
        close_in_blocks: Number(body.close_in_blocks),
      });
      return send(res, 201, await markets.view(market.id));
    }

    const id = parts[1];
    if (method === 'GET' && parts.length === 2) return send(res, 200, await markets.view(id));

    if (method === 'POST' && parts.length === 3 && parts[2] === 'bets') {
      const body = await readJson(req);
      const txid = paidTxid(req, body);

      if (txid) {
        const bet = await markets.findBet(id, { txid });
        if (bet) return send(res, 200, receipt(id, bet));
      }

      let zats: bigint;
      try {
        zats = BigInt(body.zats);
      } catch {
        throw new MarketError(400, 'zats must be a whole number of zatoshis');
      }
      const quote = await markets.quote(id, { side: body.side as Side, limit: Number(body.limit), payout_address: body.payout_address, zats });
      const requirements = {
        x402Version: 2,
        error: txid ? 'payment_not_found' : undefined,
        resource: { url: url.pathname, description: `Order for ${body.side} shares at up to ${body.limit}% on: ${quote.market.question}` },
        accepts: [
          {
            scheme: 'exact',
            network: `zcash:${quote.market.network === 'main' ? 'mainnet' : 'testnet'}`,
            asset: 'ZEC',
            amount: quote.zats.toString(),
            payTo: quote.market.address,
            maxTimeoutSeconds: 600,
            extra: {
              // The payment only counts as a bet when it carries exactly this memo.
              memo: quote.memo,
              // Private to the bettor: look the bet up later at GET /markets/:id/bets/<ref>.
              ref: quote.ref,
              uri: paymentUri(quote.market.address, quote.zats, quote.memo),
              close_height: quote.market.close_height,
              chain_tip: quote.tip,
              then: 'repeat this request with the PAYMENT-SIGNATURE header: base64 of {"txid":"..."}',
            },
          },
        ],
      };
      return send(res, 402, requirements, {
        'payment-required': Buffer.from(JSON.stringify(requirements)).toString('base64'),
        ...(txid ? { 'retry-after': String(RETRY_AFTER_SECONDS) } : {}),
      });
    }

    if (method === 'GET' && parts.length === 4 && parts[2] === 'bets') {
      const bet = await markets.findBet(id, { ref: parts[3] });
      if (!bet) return send(res, 404, { status: 'pending', note: 'not mined yet' }, { 'retry-after': String(RETRY_AFTER_SECONDS) });
      return send(res, 200, receipt(id, bet));
    }

    if (method === 'GET' && parts.length === 3 && parts[2] === 'forecast') {
      const txid = paidTxid(req, {});
      const ref = url.searchParams.get('ref') ?? undefined;
      if (txid || ref) {
        const forecast = await markets.forecast(id, { txid: txid ?? undefined, ref });
        if (forecast) return send(res, 200, forecast);
      }
      const quote = await markets.forecastQuote(id);
      const requirements = {
        x402Version: 2,
        error: txid || ref ? 'payment_not_found_or_expired' : undefined,
        resource: { url: url.pathname, description: `Forecast for: ${quote.market.question}` },
        accepts: [
          {
            scheme: 'exact',
            network: `zcash:${quote.market.network === 'main' ? 'mainnet' : 'testnet'}`,
            asset: 'ZEC',
            amount: quote.zats.toString(),
            payTo: quote.market.address,
            maxTimeoutSeconds: 600,
            extra: {
              memo: quote.memo,
              ref: quote.ref,
              uri: paymentUri(quote.market.address, quote.zats, quote.memo),
              then: 'repeat this request with ?ref=<ref> once the payment is mined',
            },
          },
        ],
      };
      return send(res, 402, requirements, { 'payment-required': Buffer.from(JSON.stringify(requirements)).toString('base64') });
    }

    if (method === 'GET' && parts.length === 3 && parts[2] === 'audit') return send(res, 200, await markets.audit(id));

    if (method === 'POST' && parts.length === 3 && parts[2] === 'resolve') {
      if (!isAdmin(req)) throw new MarketError(401, 'admin token required');
      const body = await readJson(req);
      await markets.resolve(id, body.outcome as Outcome);
      return send(res, 200, await markets.view(id));
    }

    throw new MarketError(404, 'not found');
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof MarketError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    });
  });
}

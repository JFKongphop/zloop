'use strict';
// The ZLOOP web app. No framework: a few views drawn with DOM calls. Everything that comes from
// the server or the user is added as text, never as HTML.

const app = document.getElementById('app');
let config = { network: 'main', dev: false, block_seconds: 75 };
let timers = [];
let viewToken = 0;

const every = (ms, fn) => timers.push(setInterval(fn, ms));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...clean(kids));
  return el;
}

/** Children may be nested lists and may contain empty slots; this flattens and drops those. */
function clean(kids) {
  return kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false);
}

function mount(el, ...kids) {
  el.replaceChildren(...clean(kids));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

// ---- formatting

function zec(zats) {
  const n = BigInt(zats);
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${n / 100000000n}${frac ? '.' + frac : ''} ZEC`;
}

function toZats(text) {
  const m = /^(\d{0,8})(?:\.(\d{1,8}))?$/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 100000000n + BigInt((m[2] || '').padEnd(8, '0') || '0');
}

function duration(blocks) {
  const s = blocks * config.block_seconds;
  if (s < 90) return `about ${Math.max(1, Math.round(s))} seconds`;
  if (s < 5400) return `about ${Math.round(s / 60)} minutes`;
  if (s < 129600) return `about ${Math.round(s / 3600)} hours`;
  return `about ${Math.round(s / 86400)} days`;
}

const short = (text, head = 10, tail = 6) => (text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text);

function statusText(m) {
  const left = m.close_height - m.chain_tip;
  if (m.status === 'open') return `Closes in ${duration(left)} (block ${m.close_height})`;
  if (m.status === 'closing') return 'Closing: the viewing key is published in a few blocks';
  if (m.status === 'closed') return 'Closed: waiting for the outcome';
  return `Resolved: ${m.outcome}`;
}

// ---- storage (bets placed from this browser, so they can be followed)

const store = {
  read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
const myBets = (id) => store.read('zloop.bets', {})[id] || [];
function saveBet(id, bet) {
  const all = store.read('zloop.bets', {});
  const list = (all[id] || []).filter((b) => b.ref !== bet.ref);
  all[id] = [...list, bet];
  store.write('zloop.bets', all);
}
function dropBet(id, ref) {
  const all = store.read('zloop.bets', {});
  all[id] = (all[id] || []).filter((b) => b.ref !== ref);
  store.write('zloop.bets', all);
}

// ---- small components

function copyRow(label, value) {
  const btn = h('button', { class: 'btn ghost small', type: 'button' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select it';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
  return h('div', {}, h('label', {}, label), h('div', { class: 'copy' }, h('code', { title: value }, value), btn));
}

function qrCanvas(text) {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const scale = 4;
    const canvas = h('canvas', { class: 'qr', width: n * scale, height: n * scale, role: 'img', 'aria-label': 'Payment QR code' });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(c * scale, r * scale, scale, scale);
    return canvas;
  } catch {
    return h('p', { class: 'note' }, 'The QR code could not be drawn. Use the address, amount and memo below.');
  }
}

/**
 * What an open market shows: one locked cell per bet and how close the reveal is.
 * The count is the only thing known about the bets until the market closes.
 */
const seenCells = new Map();
function vault(m, big) {
  const n = m.sealed_bets || 0;
  const cap = big ? 120 : 24;
  const before = seenCells.get(m.id) ?? n;
  seenCells.set(m.id, n);
  const cells = [];
  for (let i = 0; i < Math.min(n, cap); i++) {
    const cell = h('span', { class: 'cell' });
    // Only cells that arrived since the last draw play the pop animation.
    if (i < before) cell.style.animation = 'none';
    cells.push(cell);
  }
  if (n > cap) cells.push(h('span', { class: 'cell more' }, `+${n - cap}`));
  const span = Math.max(1, m.close_height - m.open_height);
  const done = Math.max(0, Math.min(1, (m.chain_tip - m.open_height) / span));
  const fill = h('i', {});
  fill.style.width = done * 100 + '%';
  const left = m.close_height - m.chain_tip;
  return h(
    'div',
    { class: 'vault' },
    h('div', { class: 'count' }, h('b', {}, String(n).padStart(2, '0')), n === 1 ? ' sealed order' : ' sealed orders'),
    h('div', { class: 'cells' }, cells.length ? cells : h('span', { class: 'none' }, 'empty. be the first.')),
    h('div', { class: 'fuse', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(done * 100)), 'aria-label': 'Time until the reveal' }, fill),
    h('div', { class: 'fuse-label' }, left > 0 ? `reveal in ${duration(left)} · ${left} block${left === 1 ? '' : 's'}` : 'revealing…'),
    big ? h('p', { class: 'note' }, 'Sides, stakes and addresses stay hidden until the reveal. Then the viewing key is published and every bet and payout can be checked against the fingerprint.') : null,
  );
}

const revealed = new Set();
/** The result of a revealed market: the one price every matched order traded at. */
function splitBar(m, compact) {
  const price = m.clearing_price;
  if (price === null || price === undefined)
    return h('div', { class: 'bar locked' }, h('span', {}, m.bets ? 'no orders crossed' : 'no orders'));
  const y = h('span', { class: 'y' }, compact ? `YES ${price}` : `YES share ${price}`);
  const width = Math.max(22, Math.min(78, price)) + '%';
  // The first time a result is drawn, the bar opens from an even split.
  if (revealed.has(m.id)) y.style.width = width;
  else {
    revealed.add(m.id);
    y.style.width = '50%';
    requestAnimationFrame(() => requestAnimationFrame(() => (y.style.width = width)));
  }
  return h('div', { class: 'bar' }, y, h('span', { class: 'no' }, compact ? `NO ${100 - price}` : `NO share ${100 - price}`));
}

// ---- view: markets

async function viewMarkets(token) {
  const { body: markets } = await api('/markets');
  if (token !== viewToken) return;
  const list = markets || [];
  const stat = (value, label) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
  const cards = list.map((m) => {
    const mine = myBets(m.id).length;
    return h(
      'a',
      { class: 'card', href: `#/m/${m.id}` },
      h('div', { class: 'row' }, h('span', { class: 'tag ' + m.status }, m.status), mine ? h('span', { class: 'tag mine' }, mine === 1 ? 'your bet' : `${mine} bets`) : null),
      h('h3', {}, m.question),
      h('p', {}, statusText(m)),
      m.sealed
        ? vault(m, false)
        : [splitBar(m, true), h('div', { class: 'meta' }, `${m.bets} bet${m.bets === 1 ? '' : 's'} · pot ${zec(m.pot_zats)}`)],
    );
  });
  mount(app, 
    h('h1', {}, 'Markets'),
    h('p', { class: 'lead' }, 'Open markets are sealed: you see how many bets are inside, never what they are.'),
    h(
      'div',
      { class: 'stats' },
      stat(String(list.filter((m) => m.status === 'open').length).padStart(2, '0'), 'markets open'),
      stat(String(list.reduce((a, m) => a + (m.sealed_bets || 0), 0)).padStart(2, '0'), 'bets sealed now'),
      stat(String(list.filter((m) => m.status === 'resolved').length).padStart(2, '0'), 'markets audited'),
      stat(zec(list.reduce((a, m) => a + BigInt(m.pot_zats || 0), 0n)).replace(' ZEC', ''), 'ZEC revealed'),
    ),
    h('h2', {}, 'Markets'),
    cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty' }, 'No markets yet. Open one from the Admin page.'),
  );
}

// ---- view: one market

const form = { side: 'YES', limit: 60, amount: '0.002', address: store.read('zloop.address', ''), error: '', busy: false };

function betPanel(m, rerender) {
  const pending = myBets(m.id).find((b) => b.status === 'pending');
  if (pending) return payPanel(m, pending, rerender);

  const sideBtn = (side) =>
    h('button', { type: 'button', class: form.side === side ? 'on' : '', 'data-side': side, 'aria-pressed': String(form.side === side), onclick: () => ((form.side = side), rerender()) }, side);
  const amount = h('input', { type: 'text', inputmode: 'decimal', value: form.amount, id: 'amount', oninput: (e) => (form.amount = e.target.value) });
  const address = h('textarea', { id: 'address', placeholder: config.network === 'main' ? 'u1…' : 'utest…', spellcheck: 'false', oninput: (e) => (form.address = e.target.value.trim()) }, form.address);
  const chips = ['0.001', '0.002', '0.005', '0.01'].map((a) =>
    h('button', { type: 'button', class: form.amount === a ? 'on' : '', onclick: () => ((form.amount = a), rerender()) }, a),
  );

  // The limit: how much a share that pays 1 is worth to you. It is also your stated probability.
  const limitNote = h('p', { class: 'note', style: 'margin-top:8px' });
  const limitValue = h('output', { class: 'limit-value', for: 'limit' });
  const describe = () => {
    const zats = toZats(form.amount);
    const usable = zats === null ? 0n : zats - BigInt(m.fee_reserve_zats);
    limitValue.textContent = String(form.limit);
    limitNote.textContent =
      usable > 0n
        ? `You buy ${form.side} shares only if they clear at ${form.limit} or less. Filled at ${form.limit}, this pays ${zec((usable * 100n) / BigInt(form.limit))} if ${form.side} wins. A lower clearing price buys more shares.`
        : `You buy ${form.side} shares only if they clear at ${form.limit} or less.`;
  };
  const limitRow = h(
    'div',
    { class: 'limit-row' },
    h('input', { type: 'range', id: 'limit', min: '1', max: '99', step: '1', value: String(form.limit), oninput: (e) => ((form.limit = Number(e.target.value)), describe()) }),
    limitValue,
  );
  describe();
  amount.addEventListener('input', describe);

  async function submit() {
    const zats = toZats(form.amount);
    if (zats === null) return ((form.error = 'Enter the amount in ZEC, for example 0.002.'), rerender());
    form.busy = true;
    form.error = '';
    rerender();
    const res = await api(`/markets/${m.id}/bets`, { method: 'POST', body: { side: form.side, limit: form.limit, zats: zats.toString(), payout_address: form.address } });
    form.busy = false;
    if (res.status !== 402) {
      form.error = res.body?.error || 'The server could not take the bet.';
      return rerender();
    }
    const terms = res.body.accepts[0];
    store.write('zloop.address', form.address);
    saveBet(m.id, {
      ref: terms.extra.ref,
      side: form.side,
      limit: form.limit,
      zats: terms.amount,
      payout_address: form.address,
      pay_to: terms.payTo,
      memo: terms.extra.memo,
      uri: terms.extra.uri,
      status: 'pending',
      paid: false,
    });
    rerender();
  }

  return h(
    'div',
    { class: 'panel' },
    h('h3', {}, 'Place a sealed order'),
    h('label', {}, 'Your side'),
    h('div', { class: 'seg' }, sideBtn('YES'), sideBtn('NO')),
    h('label', { for: 'limit' }, 'Most I pay per share'),
    limitRow,
    limitNote,
    h('label', { for: 'amount' }, 'Budget in ZEC'),
    amount,
    h('div', { class: 'chips' }, chips),
    h('label', { for: 'address' }, 'Pay my winnings to'),
    address,
    h('p', { class: 'note' }, 'A shielded Zcash address. It becomes visible when the market closes, so use a fresh one if that matters to you.'),
    form.error ? h('p', { class: 'err', role: 'alert' }, form.error) : null,
    h('button', { class: 'btn wide', type: 'button', disabled: form.busy, onclick: submit }, form.busy ? 'Asking…' : 'Continue to payment'),
    h('p', { class: 'note' }, `All orders open together at the close and trade at one price. Budget that buys nothing comes back. ${zec(m.fee_reserve_zats)} of each order covers the payout's network fee.`),
  );
}

function payPanel(m, bet, rerender) {
  const devPay = async (e) => {
    e.target.disabled = true;
    await api('/dev/pay', { method: 'POST', body: { address: bet.pay_to, zats: bet.zats, memo: bet.memo } });
    saveBet(m.id, { ...bet, paid: true });
    rerender();
  };
  return h(
    'div',
    { class: 'panel' },
    h('h3', {}, `Pay ${zec(bet.zats)} to bet ${bet.side}`),
    config.dev
      ? h('p', { class: 'note' }, 'This server runs on a stand-in chain, so no real ZEC is needed.')
      : h('p', { class: 'note' }, 'Scan with a Zcash wallet. The payment must be shielded and carry the memo exactly as shown.'),
    config.dev ? null : qrCanvas(bet.uri),
    config.dev
      ? h('button', { class: 'btn wide', type: 'button', disabled: bet.paid, onclick: devPay }, bet.paid ? 'Paid with test coins' : 'Pay with test coins')
      : h('a', { class: 'btn ghost wide', href: bet.uri }, 'Open in a wallet on this device'),
    copyRow('Address', bet.pay_to),
    copyRow('Amount', zec(bet.zats).replace(' ZEC', '')),
    copyRow('Memo', bet.memo),
    h('div', { class: 'wait', role: 'status' }, h('span', { class: 'spin' }), h('span', {}, `Waiting for the payment to be mined. A block takes ${duration(1)}.`)),
    h('button', { class: 'btn ghost small', type: 'button', style: 'margin-top:14px', onclick: () => (dropBet(m.id, bet.ref), rerender()) }, 'Cancel this bet'),
    h('p', { class: 'note' }, 'Cancel only if you have not paid. A payment already sent still counts as a bet.'),
  );
}

function betOutcome(m, bet) {
  if (bet.status === 'pending') return h('span', {}, bet.paid ? 'Paid, waiting for a block' : 'Waiting for payment');
  if (bet.status === 'late') return h('span', {}, 'Arrived after the close; refunded with the payouts');
  if (m.status !== 'resolved') return h('span', { class: 'good' }, `Sealed in block ${bet.mined_height}`);
  const payout = (m.payouts || []).find((p) => p.bet_txid === bet.txid);
  if (!payout) return h('span', { class: 'bad' }, 'Lost');
  if (payout.kind === 'win') return h('span', { class: 'good' }, `Won ${zec(payout.zats)}`);
  const filled = Number((m.bet_list || []).find((b) => b.txid === bet.txid)?.spent_zats || 0);
  return filled ? h('span', { class: 'bad' }, `Lost · ${zec(payout.zats)} unfilled came back`) : h('span', {}, `Not filled · ${zec(payout.zats)} back`);
}

function myBetsPanel(m) {
  const bets = myBets(m.id);
  if (!bets.length) return null;
  return h(
    'div',
    { class: 'panel', style: 'margin-top:16px' },
    h('h3', {}, 'Your bets from this browser'),
    h(
      'div',
      { class: 'tablewrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Order'), h('th', { class: 'num' }, 'Budget'), h('th', {}, 'Status'))),
        h('tbody', {}, bets.map((b) => h('tr', {}, h('td', {}, `${b.side} ≤ ${b.limit ?? '?'}`), h('td', { class: 'num' }, zec(b.zats)), h('td', {}, betOutcome(m, b))))),
      ),
    ),
  );
}

function resultsPanel(m, auditReport) {
  const paid = (m.payouts || []).reduce((a, p) => a + BigInt(p.zats), 0n);
  const payoutFor = (txid) => (m.payouts || []).find((p) => p.bet_txid === txid);
  return [
    h('h2', {}, 'Result'),
    h(
      'div',
      { class: 'panel' },
      splitBar(m),
      h(
        'dl',
        { class: 'kv', style: 'margin-top:14px' },
        h('dt', {}, 'Outcome'),
        h('dd', {}, m.outcome ? m.outcome + (m.refund_reason ? ` (everyone refunded: ${m.refund_reason})` : '') : 'not declared yet'),
        h('dt', {}, 'Clearing price'),
        h('dd', {}, m.clearing_price === null ? 'none: no YES and NO orders crossed' : `a YES share cost ${m.clearing_price}, a NO share ${100 - m.clearing_price}. Every matched order traded at this price.`),
        h('dt', {}, 'Matched'),
        h('dd', {}, `${zec(m.matched_zats)} of shares on each side, from ${m.bets} order${m.bets === 1 ? '' : 's'} worth ${zec(m.pot_zats)}`),
        Number(m.forecast_income_zats) ? [h('dt', {}, 'Forecast income'), h('dd', {}, `${zec(m.forecast_income_zats)} from ${m.forecast_sales} sale${m.forecast_sales === 1 ? '' : 's'}, shared among the winners`)] : null,
        m.outcome ? [h('dt', {}, 'Paid out'), h('dd', {}, zec(paid))] : null,
        m.payout_txid ? [h('dt', {}, 'Payout transaction'), h('dd', { class: 'meta' }, m.payout_txid)] : null,
      ),
    ),
    h('h2', {}, 'Every bet, now unsealed'),
    m.bet_list.length
      ? h(
          'div',
          { class: 'panel tablewrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Side'), h('th', { class: 'num' }, 'Limit'), h('th', { class: 'num' }, 'Paid in'), h('th', { class: 'num' }, 'Filled'), h('th', { class: 'num' }, 'Shares'), h('th', { class: 'num' }, 'Paid out'))),
            h(
              'tbody',
              {},
              m.bet_list.map((b) => {
                const p = payoutFor(b.txid);
                return h(
                  'tr',
                  {},
                  h('td', {}, b.side + (b.late ? ' (late)' : '')),
                  h('td', { class: 'num' }, String(b.limit)),
                  h('td', { class: 'num' }, zec(b.stake_zats)),
                  h('td', { class: 'num' }, b.late ? '—' : Math.round((Number(b.spent_zats) / Math.max(1, Number(b.stake_zats) - Number(m.fee_reserve_zats))) * 100) + '%'),
                  h('td', { class: 'num' }, zec(b.shares_zats).replace(' ZEC', '')),
                  h('td', { class: 'num' }, m.outcome ? (p ? zec(p.zats) : '0') : '…'),
                );
              }),
            ),
          ),
        )
      : h('div', { class: 'empty' }, 'Nobody bet on this market.'),
    h('h2', {}, 'Audit'),
    h(
      'div',
      { class: 'panel' },
      auditReport
        ? [
            h('p', { class: 'verdict ' + (auditReport.ok ? 'good' : 'bad') }, auditReport.ok ? 'All checks pass' : m.outcome ? 'A check failed' : 'Waiting for the outcome'),
            h('ul', { class: 'checks' }, auditReport.checks.map((c) => h('li', {}, h('b', { class: c.ok ? 'good' : 'bad' }, c.ok ? 'PASS' : 'FAIL'), h('span', {}, `${c.name}: ${c.detail}`)))),
          ]
        : h('p', { class: 'note' }, 'Loading the checks…'),
      h('p', { class: 'note' }, 'These checks were run by this server. To check independently, run the audit yourself with the published key:'),
      h('pre', {}, `node server/src/audit.ts ${location.origin} ${m.id}`),
      copyRow('Viewing key, published at close', m.viewing_key),
      copyRow('Fingerprint committed at open', m.viewing_key_fingerprint),
    ),
  ];
}

async function viewMarket(id, token) {
  let m = null;
  let auditReport = null;
  let lastKey = '';

  const info = h('div', {});
  const side = h('div', {});
  // Filled by views.js: the forecast for sale, and the agents seen in this market.
  const forecastBox = h('div', {});
  const agentsBox = h('div', {});
  mount(app, h('a', { class: 'back', href: '#/markets' }, '← All markets'), h('div', { class: 'detail' }, h('div', {}, info, agentsBox), h('div', {}, side, forecastBox)));

  function drawSide() {
    mount(side, 
      m.status === 'open'
        ? betPanel(m, drawSide)
        : h('div', { class: 'panel' }, h('h3', {}, 'Betting is closed'), h('p', { class: 'note', style: 'margin:0' }, statusText(m))),
      myBetsPanel(m),
    );
  }

  function drawInfo() {
    mount(info, 
      h('span', { class: 'tag ' + m.status }, m.status),
      h('h1', { class: 'q', style: 'margin-top:14px' }, m.question),
      h('p', { class: 'lead' }, statusText(m)),
      h(
        'dl',
        { class: 'kv', style: 'margin-top:18px' },
        h('dt', {}, 'Decided by'),
        h('dd', {}, m.source),
        h('dt', {}, 'Chain'),
        h('dd', {}, `${config.dev ? 'stand-in chain' : m.network + 'net'}, block ${m.chain_tip}`),
        h('dt', {}, 'Smallest bet'),
        h('dd', {}, zec(m.min_bet_zats)),
        h('dt', {}, 'Key fingerprint'),
        h('dd', { class: 'meta' }, m.viewing_key_fingerprint),
      ),
      m.sealed
        ? vault(m, true)
        : resultsPanel(m, auditReport),
    );
  }

  async function refresh() {
    const res = await api(`/markets/${id}`);
    if (token !== viewToken) return;
    if (res.status !== 200) return mount(app, h('a', { class: 'back', href: '#/markets' }, '← All markets'), h('div', { class: 'empty' }, 'This market does not exist.'));
    m = res.body;

    // Follow bets placed from this browser until they are mined.
    for (const bet of myBets(id).filter((b) => b.status === 'pending')) {
      const found = await api(`/markets/${id}/bets/${bet.ref}`);
      if (found.status === 200) saveBet(id, { ...bet, status: found.body.status, txid: found.body.txid, mined_height: found.body.mined_height });
    }
    if (!m.sealed) {
      const a = await api(`/markets/${id}/audit`);
      if (a.status === 200) auditReport = a.body;
    }
    if (token !== viewToken) return;

    // The bet form keeps what the user typed: it is redrawn only when something it shows changes.
    const key = [m.status, JSON.stringify(myBets(id).map((b) => [b.ref, b.status]))].join('|');
    drawInfo();
    if (key !== lastKey) drawSide();
    drawForecast(m, forecastBox);
    drawMarketAgents(m, agentsBox);
    lastKey = key;
  }

  await refresh();
  every(config.dev ? 1500 : 10000, refresh);
}

// ---- view: admin

const admin = { token: '', error: '', confirm: null, busy: false, notice: '' };
try {
  admin.token = sessionStorage.getItem('zloop.admin') || '';
} catch {}

let adminDraws = 0;

async function viewAdmin(token) {
  const draw = () => viewAdmin(viewToken);
  // Several redraws can be in flight at once; only the newest may touch the page.
  const mine = ++adminDraws;
  const stale = () => token !== viewToken || mine !== adminDraws;

  if (admin.token && (await api('/admin/check', { method: 'POST', token: admin.token })).status !== 200) {
    admin.token = '';
    admin.error = 'That token was not accepted.';
  }
  if (stale()) return;

  if (!admin.token) {
    const input = h('input', { type: 'password', id: 'token', autocomplete: 'off' });
    const go = () => {
      admin.token = input.value.trim();
      admin.error = '';
      try {
        sessionStorage.setItem('zloop.admin', admin.token);
      } catch {}
      draw();
    };
    return mount(app, 
      h('h1', {}, 'Admin'),
      h('p', { class: 'lead' }, 'Open markets and declare outcomes. This needs the admin token the server was started with.'),
      h(
        'div',
        { class: 'panel', style: 'max-width:440px;margin-top:20px' },
        h('label', { for: 'token', style: 'margin-top:0' }, 'Admin token'),
        input,
        admin.error ? h('p', { class: 'err', role: 'alert' }, admin.error) : null,
        h('button', { class: 'btn wide', type: 'button', onclick: go }, 'Continue'),
        config.dev ? h('p', { class: 'note' }, 'On the development server started with "npm run dev", the token is: dev') : null,
      ),
    );
  }

  const { body: markets } = await api('/markets');
  if (stale()) return;

  const question = h('input', { type: 'text', id: 'q', placeholder: 'Will … happen by …?' });
  const source = h('input', { type: 'text', id: 's', placeholder: 'The public source that decides it' });
  const amount = h('input', { type: 'number', id: 'n', min: '1', value: config.dev ? '2' : '24' });
  const unit = h('select', { id: 'u', 'aria-label': 'Unit' }, h('option', { value: '60' }, 'minutes'), h('option', { value: '3600', selected: !config.dev }, 'hours'), h('option', { value: '86400' }, 'days'));
  if (config.dev) unit.value = '60';

  async function open() {
    const blocks = Math.max(1, Math.ceil((Number(amount.value) * Number(unit.value)) / config.block_seconds));
    admin.busy = true;
    const res = await api('/markets', { method: 'POST', token: admin.token, body: { question: question.value, source: source.value, close_in_blocks: blocks } });
    admin.busy = false;
    if (res.status === 201) location.hash = `#/m/${res.body.id}`;
    else {
      admin.notice = res.body?.error || 'The market could not be opened.';
      draw();
    }
  }

  async function resolve(id, outcome) {
    admin.busy = true;
    const res = await api(`/markets/${id}/resolve`, { method: 'POST', token: admin.token, body: { outcome } });
    admin.busy = false;
    admin.confirm = null;
    admin.notice = res.status === 200 ? `Market ${id} resolved as ${outcome}; payouts sent.` : res.body?.error || 'Could not resolve.';
    draw();
  }

  const row = (m) => {
    let action = h('span', { class: 'meta' }, m.status === 'resolved' ? `resolved ${m.outcome}` : statusText(m));
    if (m.status === 'closed') {
      action =
        admin.confirm?.id === m.id
          ? h(
              'div',
              { class: 'row' },
              h('span', {}, `Declare ${admin.confirm.outcome}? This sends the payouts and cannot be undone.`),
              h('button', { class: 'btn small', type: 'button', disabled: admin.busy, onclick: (e) => ((e.target.disabled = true), (e.target.textContent = 'Sending…'), resolve(m.id, admin.confirm.outcome)) }, 'Yes, resolve'),
              h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((admin.confirm = null), draw()) }, 'Cancel'),
            )
          : h(
              'div',
              { class: 'row' },
              ['YES', 'NO'].map((o) => h('button', { class: 'btn small', type: 'button', onclick: () => ((admin.confirm = { id: m.id, outcome: o }), draw()) }, o)),
              h('button', { class: 'btn danger small', type: 'button', onclick: () => ((admin.confirm = { id: m.id, outcome: 'VOID' }), draw()) }, 'Void'),
            );
    }
    return h(
      'div',
      { class: 'card', style: 'margin-bottom:10px' },
      h('div', { class: 'row' }, h('span', { class: 'tag ' + m.status }, m.status), h('a', { href: `#/m/${m.id}` }, m.question)),
      h('div', { class: 'meta', style: 'margin:6px 0 10px' }, m.sealed ? `decided by ${m.source}` : `decided by ${m.source} · ${m.bets} bets · pot ${zec(m.pot_zats)}`),
      action,
    );
  };

  mount(app, 
    h('h1', {}, 'Admin'),
    admin.notice ? h('p', { class: 'lead', role: 'status' }, admin.notice) : null,
    h('h2', {}, 'Open a market'),
    h(
      'div',
      { class: 'panel', style: 'max-width:640px' },
      h('label', { for: 'q', style: 'margin-top:0' }, 'Question (answerable with yes or no)'),
      question,
      h('label', { for: 's' }, 'Decided by'),
      source,
      h('label', { for: 'n' }, 'Closes in'),
      h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:90px' }, amount), h('div', { style: 'flex:1;min-width:120px' }, unit)),
      h('p', { class: 'note' }, `Time is counted in blocks of about ${config.block_seconds} seconds, so the closing time is approximate. A new shielded wallet is created for the market.`),
      h('button', { class: 'btn wide', type: 'button', disabled: admin.busy, onclick: open }, 'Open market'),
    ),
    h('h2', {}, 'Markets'),
    (markets || []).length ? markets.map(row) : h('div', { class: 'empty' }, 'No markets yet.'),
    h('button', { class: 'btn ghost small', type: 'button', style: 'margin-top:20px', onclick: () => { admin.token = ''; try { sessionStorage.removeItem('zloop.admin'); } catch {} draw(); } }, 'Sign out'),
  );
}

// ---- view: how it works

function viewHow() {
  const step = (n, title, text) => h('div', { class: 'card' }, h('span', { class: 'n' }, n), h('h3', { style: 'margin-top:6px' }, title), h('p', {}, text));
  const o = location.origin;
  mount(app, 
    h('h1', {}, 'Docs'),
    h('p', { class: 'lead' }, 'A bet is a shielded Zcash payment whose memo says what it is. The chain is the record, so the audit needs nothing from us but the viewing key.'),
    h('h2', {}, 'One market, six steps'),
    h(
      'div',
      { class: 'grid' },
      step('01 OPEN', 'The terms are fixed first', 'The question, the closing block, the source that decides it, the market’s shielded address, and a fingerprint of its viewing key.'),
      step('02 BET', 'Ask, and get a 402', 'An agent posts a side and an amount. The answer is “402 Payment Required” with the address, the amount and a memo.'),
      step('03 PAY', 'The payment is the bet', 'A shielded payment carrying that memo. The server keeps no list of bets.'),
      step('04 SEALED', 'Nothing shows while open', 'Not who bet, not which side, not how much. There are no odds to copy and no crowd to follow.'),
      step('05 CLOSE', 'The key is published', 'It must match the fingerprint from step one. Winners are paid in shielded ZEC, in proportion to their stake.'),
      step('06 AUDIT', 'Anyone can check', 'One command reads every bet and payout from the chain and recomputes the split with the same code the server ran.'),
    ),
    h('h2', {}, 'How the price is found'),
    h(
      'div',
      { class: 'panel' },
      h('p', { style: 'margin:0 0 10px' }, 'A YES share pays 1 if the answer is yes; a NO share pays 1 if it is no. An order is a side, a budget, and a limit: the most you pay per share, from 1 to 99. Your limit is how likely you think your side is.'),
      h('p', { style: 'margin:0 0 10px' }, 'At a YES price of p, a YES buyer pays p and a NO buyer pays 100 − p, and together they fund one share each. At the close, the price that matches the most shares is chosen. Everyone whose limit allows it trades at that same price; the side with too much demand is cut back in proportion; the rest of each budget goes back.'),
      h('pre', {}, `orders                         at YES price 60
  A  YES  budget 0.006  limit 60   buys 0.010 shares   (limit 60 ≥ 60)
  B  NO   budget 0.004  limit 40   buys 0.010 shares   (limit 40 ≥ 100 − 60)
  C  YES  budget 0.009  limit 30   buys nothing        (limit 30 < 60), 0.009 back

if YES wins:  A is paid 0.010     B gets nothing     C got its 0.009 back
if NO wins:   B is paid 0.010     A gets nothing     C got its 0.009 back`),
      h('p', { class: 'note' }, 'If every order accepts any price, this gives the same odds as a plain betting pool. Limits are what let you say “only at this price”, sealed, with nobody able to trade ahead of you.'),
    ),
    h('h2', {}, 'Why sealed'),
    h(
      'div',
      { class: 'grid' },
      step('', 'Honest forecasts', 'When positions are public, traders copy the largest one. Sealed bets make each agent commit to what it actually believes.'),
      step('', 'Knowledge without exposure', 'Someone who knows something can bet on it without their position pointing back at them.'),
      step('', 'No trading against you', 'An agent’s strategy cannot be read from its bets while the market is live.'),
    ),
    h('h2', {}, 'For agents: the API'),
    h('pre', {}, `# 1. ask: the answer is 402 with what to pay
curl -i -X POST ${o}/markets/<market id>/bets \\
  -H 'content-type: application/json' \\
  -d '{"side":"YES","limit":60,"zats":200000,"payout_address":"<your shielded address>"}'

# 2. pay "amount" zatoshis to "payTo" with the memo from "extra.memo"

# 3. look the bet up with the private reference from "extra.ref"
curl ${o}/markets/<market id>/bets/<ref>

# buy the forecast of an open market the same way: 402, pay, read
curl -i ${o}/markets/<market id>/forecast
curl ${o}/markets/<market id>/forecast?ref=<ref>`),
    h('h2', {}, 'For agents: as a tool'),
    h('pre', {}, `{ "mcpServers": { "zloop": {
    "command": "node", "args": ["server/src/mcp.ts"],
    "env": { "ZLOOP_SERVER": "${o}", "ZLOOP_AGENT_WALLET_DIR": "~/.zloop/agent" } } } }`),
    h('p', { class: 'note' }, 'Tools: zloop_list_markets, zloop_get_market, zloop_place_bet, zloop_bet_status.'),
    h('h2', {}, 'What you are trusting'),
    h(
      'ul',
      { class: 'plain' },
      h('li', {}, h('b', {}, 'We hold the pot until payout. '), 'Zcash has no smart contracts, so the market runs on our server. It is verifiable afterwards, not trustless.'),
      h('li', {}, h('b', {}, 'We can see the bets. '), 'The seal is against the public and other traders, not against the operator.'),
      h('li', {}, h('b', {}, 'We declare the outcome, '), 'from the source named when the market opened.'),
      h('li', {}, h('b', {}, 'At close, the key reveals every bet in that market: '), 'side, stake and payout address.'),
      h('li', {}, h('b', {}, 'Each bet leaves 10,000 zatoshis '), 'in the market wallet to cover the network fee of the payout.'),
    ),
  );
}

// ---- routing

async function route() {
  timers.forEach(clearInterval);
  timers = [];
  const token = ++viewToken;
  const [, page, id] = location.hash.split('/');
  if (page !== 'admin') admin.notice = '';
  const name = page === 'm' ? 'markets' : page || 'home';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.nav === name);
  window.scrollTo(0, 0);

  if (page === 'm' && id) return viewMarket(id, token);
  if (page === 'how') return viewHow();
  if (page === 'admin') return viewAdmin(token);
  if (page === 'arena') return viewArena(token);
  if (page === 'portfolio') return viewPortfolio(token);
  if (page === 'history') return viewHistory(token);
  if (page === 'markets') {
    await viewMarkets(token);
    return every(config.dev ? 3000 : 20000, () => viewMarkets(token));
  }
  return viewLanding(token);
}

(async () => {
  try {
    config = (await api('/config')).body || config;
  } catch {}
  const net = document.getElementById('net');
  net.textContent = config.dev ? 'stand-in chain' : config.network + 'net';
  net.classList.toggle('dev', config.dev);
  window.addEventListener('hashchange', route);
  route();
})();

// ---- background: a slow dithered gold tide, drawn in big pixels

(function background() {
  const canvas = document.getElementById('bg');
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const CELL = 12;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const SHADES = ['#2a2005', '#6b5210', '#c99a17', '#ffc928'];
  let cols = 0;
  let rows = 0;
  function size() {
    cols = Math.ceil(innerWidth / CELL);
    rows = Math.ceil(innerHeight / CELL);
    canvas.width = cols;
    canvas.height = rows;
  }
  size();
  addEventListener('resize', size);
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < 90 || document.hidden) return;
    last = now;
    const t = now / 1000;
    ctx.clearRect(0, 0, cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // Two crossing waves, strongest toward the right edge so text on the left stays clear.
        const wave = Math.sin(x * 0.11 + t * 0.7 + Math.sin(y * 0.09 + t * 0.3) * 1.6) + Math.sin(y * 0.16 - t * 0.5 + x * 0.04);
        const level = ((wave + 2) / 4) * (0.15 + 0.85 * Math.pow(x / cols, 2.2)) * 5 - 0.55;
        const shade = Math.floor(level + BAYER[(y & 3) * 4 + (x & 3)] / 16);
        if (shade > 0) {
          ctx.fillStyle = SHADES[Math.min(shade, SHADES.length) - 1];
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }
  requestAnimationFrame(frame);
})();

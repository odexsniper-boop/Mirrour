// Real-time stream tests: a fake WebSocket stands in for the RPC's pubsub endpoint.
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletStream, looksLikeSwap, toWsUrl } from '../engine/walletStream.mjs';
import { SolanaWalletWatcher, WSOL_MINT } from '../engine/walletWatcher.mjs';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const WALLET2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MEME = 'MemeMint1111111111111111111111111111111pump';
const POOL = 'Pool1111111111111111111111111111111111111111';
const FEE = 5000;
const PUMP_LOGS = ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', 'Program log: Instruction: Buy', 'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success'];
const SPAM_LOGS = ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'];

/** Fake WebSocket: records what the client sends, lets the test push messages / drop the link. */
class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.all.push(this);
    this.autoAnswer = true;
    this.nextSub = 100;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(text) {
    const m = JSON.parse(text);
    this.sent.push(m);
    if (!this.autoAnswer) return;
    setTimeout(() => {
      if (m.method === 'accountSubscribe' && String(this.url).includes('noaccount')) this.reply({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: "Method 'accountSubscribe' not found" } });
      else if (m.method === 'logsSubscribe' || m.method === 'accountSubscribe') this.reply({ jsonrpc: '2.0', id: m.id, result: this.nextSub++ });
      else if (m.method === 'logsUnsubscribe' || m.method === 'accountUnsubscribe') this.reply({ jsonrpc: '2.0', id: m.id, result: true });
      else this.reply({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params' } });
    }, 0);
  }
  reply(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  push(sub, value) {
    this.reply({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot: 1 }, value } } });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close() {
    this.readyState = 3;
  }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 1000) => {
  for (let t = 0; t < ms && !cond(); t += 5) await tick(5);
};
const subFor = (ws, addr) => {
  const req = ws.sent.find((m) => m.method === 'logsSubscribe' && m.params[0].mentions[0] === addr);
  return req ? 100 + ws.sent.filter((m) => m.method === 'logsSubscribe').indexOf(req) : null;
};

test('S1 swap log filter and ws url', () => {
  assert.equal(looksLikeSwap(PUMP_LOGS), true);
  assert.equal(looksLikeSwap(['Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]']), true);
  assert.equal(looksLikeSwap(['Program log: Instruction: SwapBaseInput']), true);
  assert.equal(looksLikeSwap(SPAM_LOGS), false, 'plain transfers are not worth a lookup');
  assert.equal(looksLikeSwap(['Log truncated']), true);
  assert.equal(toWsUrl('https://solana-mainnet.g.alchemy.com/v2/KEY'), 'wss://solana-mainnet.g.alchemy.com/v2/KEY');
  assert.equal(toWsUrl('http://localhost:8899'), 'ws://localhost:8899/');
  assert.equal(toWsUrl('nope'), null);
});

test('S2 subscribes every wallet, follows list changes, resubscribes after a dropped connection', async () => {
  FakeWS.all = [];
  const got = [];
  const s = new WalletStream({ url: 'wss://x', WebSocketImpl: FakeWS, onLogs: (a, ev) => got.push([a, ev.signature]) });
  s.setWallets([WALLET]);
  s.start();
  await until(() => s.status().subscriptions === 1);
  const ws = FakeWS.all[0];
  assert.equal(s.status().connected, true);
  assert.equal(s.status().subscriptions, 1);
  ws.push(100, { signature: 'sigA', err: null, logs: PUMP_LOGS });
  assert.deepEqual(got, [[WALLET, 'sigA']]);

  s.setWallets([WALLET, WALLET2]);
  for (let i = 0; i < 50 && s.status().subscriptions < 2; i++) await tick(5);
  assert.equal(s.status().subscriptions, 2);
  s.setWallets([WALLET2]);
  await until(() => ws.sent.some((m) => m.method === 'logsUnsubscribe'));
  assert.ok(ws.sent.some((m) => m.method === 'logsUnsubscribe' && m.params[0] === 100), 'removed wallet unsubscribed');
  ws.push(100, { signature: 'late', err: null, logs: PUMP_LOGS });
  assert.equal(got.length, 1, 'no events for a wallet we stopped watching');

  s.backoffMs = 1;
  ws.drop();
  assert.equal(s.status().connected, false);
  for (let i = 0; i < 50 && s.status().subscriptions < 1; i++) await tick(10);
  assert.equal(FakeWS.all.length, 2, 'reconnected');
  assert.equal(s.status().subscriptions, 1, 'wallets resubscribed on the new connection');
  s.stop();
});

test('S3 keepalive: a silent connection is replaced', async () => {
  FakeWS.all = [];
  const s = new WalletStream({ url: 'wss://x', WebSocketImpl: FakeWS, keepaliveMs: 10 });
  s.start();
  await tick();
  FakeWS.all[0].autoAnswer = false; // stops answering
  // keepalive fires at 10 ms, deadline is 10 s in production; shorten for the test
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 10_000 ? 5 : ms, ...a);
  try {
    await tick(60);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(FakeWS.all.length >= 2, 'reconnected after the keepalive went unanswered');
  s.stop();
});

function makeBuyTx(sig) {
  const keys = [WALLET, POOL, 'WalletTokenAcc1111111111111111111111111111'];
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: FEE,
      preBalances: [5e9, 1e9, 1e9],
      postBalances: [5e9 - 0.5e9 - FEE, 1e9, 1e9],
      preTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 } }],
      postTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '5000000000000', decimals: 6, uiAmount: 5_000_000 } }],
    },
    transaction: { signatures: [sig], message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true })) } },
  };
}

test('S4 watcher: pushed swap becomes a signal fast; failed / spam pushes cost no RPC; polling never doubles it', async () => {
  FakeWS.all = [];
  const txs = new Map();
  const notYet = new Set(); // first getTransaction returns null (RPC not caught up yet)
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) {
      const mint = String(url).split('/').pop();
      const pairs = [{ chainId: 'solana', dexId: 'pumpfun', baseToken: { address: mint, symbol: mint === WSOL_MINT ? 'SOL' : 'MEME', name: 'x' }, priceUsd: mint === WSOL_MINT ? '200' : '0.0001', marketCap: 100000, liquidity: { usd: 25000 } }];
      return new Response(JSON.stringify({ pairs }), { status: 200 });
    }
    const body = JSON.parse(opts.body);
    calls.push(body.method);
    let result = null;
    if (body.method === 'getTransaction') {
      const sig = body.params[0];
      if (notYet.has(sig)) notYet.delete(sig);
      else result = txs.get(sig) || null;
    } else if (body.method === 'getSignaturesForAddress') {
      result = [...txs.keys()].reverse().map((signature) => ({ signature, err: null }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl, WebSocketImpl: FakeWS, rpcUrl: 'https://rpc.example', onSignal: (s) => got.push(s), pollIntervalMs: 3_600_000 });
  w.setWallets([{ address: WALLET, label: 'whale' }]);
  w.start();
  await until(() => w.getStatus().stream.subscriptions === 1);
  await w.pollOnce(); // baseline poll (no history yet)
  const ws = FakeWS.all[0];
  assert.equal(ws.url, 'wss://rpc.example/');
  assert.equal(w.getStatus().stream.connected, true);

  const before = calls.length;
  ws.push(100, { signature: 'failedSpam', err: { InstructionError: [0, 'x'] }, logs: SPAM_LOGS });
  ws.push(100, { signature: 'dustSpam', err: null, logs: SPAM_LOGS });
  await tick(10);
  assert.equal(calls.length, before, 'failed and non-swap pushes are dropped without any RPC call');

  txs.set('realBuy', makeBuyTx('realBuy'));
  notYet.add('realBuy');
  ws.push(100, { signature: 'realBuy', err: null, logs: PUMP_LOGS });
  for (let i = 0; i < 50 && !got.length; i++) await tick(20);
  assert.equal(got.length, 1, 'pushed buy emitted');
  assert.equal(got[0].via, 'stream');
  assert.equal(got[0].side, 'buy');
  assert.ok(got[0].streamMs < 1500, `ready ${got[0].streamMs} ms after the push (incl. one retry)`);

  await w.pollOnce(); // safety-net poll sees the same signature
  assert.equal(got.length, 1, 'polling does not copy it a second time');
  const st = w.getStatus().stream;
  assert.equal(st.failedTx, 1);
  assert.equal(st.notSwap, 1);
  assert.equal(st.signals, 1);
  w.stop();
  assert.equal(w.getStatus().stream.connected, false);
});

test('S5 realtime can be switched off and on', async () => {
  FakeWS.all = [];
  const w = new SolanaWalletWatcher({ fetchImpl: async () => new Response(JSON.stringify({ result: [] })), WebSocketImpl: FakeWS, rpcUrl: 'https://rpc.example', pollIntervalMs: 3_600_000 });
  w.setWallets([{ address: WALLET }]);
  w.start();
  await until(() => w.getStatus().stream.connected);
  assert.equal(w.getStatus().stream.connected, true);
  w.setStreamEnabled(false);
  assert.equal(w.getStatus().stream.connected, false);
  assert.equal(w.getStatus().stream.enabled, false);
  w.setStreamEnabled(true);
  await until(() => w.getStatus().stream.connected);
  assert.equal(w.getStatus().stream.connected, true);
  w.stop();
});

test('S6 a handshake that fails with only an error (Node quirk) is retried', async () => {
  class FailWS {
    static n = 0;
    constructor() {
      FailWS.n += 1;
      this.readyState = 0;
      setTimeout(() => this.onerror?.({ message: 'Received network error or non-101 status code.' }), 0);
    }
    send() {}
    close() {}
  }
  const s = new WalletStream({ url: 'wss://x', WebSocketImpl: FailWS });
  s.backoffMs = 1;
  s.maxBackoffMs = 2;
  s.start();
  await until(() => FailWS.n >= 3);
  assert.ok(FailWS.n >= 3, `retried (${FailWS.n} attempts)`);
  assert.ok(s.status().reconnects >= 2);
  assert.match(s.status().lastError, /non-101/);
  s.stop();
});

test('S7 a spam-flooded wallet switches to balance watching; calm wallets keep streaming', async () => {
  FakeWS.all = [];
  const got = [];
  const bal = [];
  const s = new WalletStream({ url: 'wss://x', WebSocketImpl: FakeWS, floodPerSec: 5, floodCooldownMs: 60_000, onLogs: (a) => got.push(a), onAccount: (a, ev) => bal.push([a, ev.lamports]) });
  s.setWallets([WALLET, WALLET2]);
  s.start();
  await until(() => s.status().subscriptions === 2);
  const ws = FakeWS.all[0];
  const subBusy = subFor(ws, WALLET);
  const subCalm = subFor(ws, WALLET2);
  for (let i = 0; i < 80; i++) ws.push(subBusy, { signature: `spam${i}`, err: { x: 1 }, logs: [] });
  ws.push(subCalm, { signature: 'calm1', err: null, logs: [] });
  await until(() => s.status().subscriptions === 2 && s.status().balanceWatch.length === 1);
  assert.ok(ws.sent.some((m) => m.method === 'logsUnsubscribe' && m.params[0] === subBusy), 'log stream for the flooded wallet stopped');
  const accReq = ws.sent.find((m) => m.method === 'accountSubscribe');
  assert.equal(accReq.params[0], WALLET, 'its SOL balance is watched instead');
  assert.deepEqual(s.status().balanceWatch, [WALLET]);
  assert.ok(got.filter((a) => a === WALLET).length <= 51);
  assert.equal(got.at(-1), WALLET2, 'the calm wallet still streams');
  // balance change pushed
  const accSub = 100 + ws.sent.filter((m) => m.method === 'logsSubscribe' || m.method === 'accountSubscribe').indexOf(accReq);
  ws.reply({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: accSub, result: { context: { slot: 5 }, value: { lamports: 9e9 } } } });
  assert.deepEqual(bal, [[WALLET, 9e9]]);
  s.stop();
});

test('S8 watcher: a pushed SOL move on a flooded wallet finds its own trade within the spam right away', async () => {
  FakeWS.all = [];
  const t = Math.floor(Date.now() / 1000);
  let lamports = 10e9;
  const own = []; // signatures the wallet signed (newest first)
  const txs = new Map();
  const spamTx = (sig) => ({ slot: 1, blockTime: t, meta: { err: null, fee: 5000, preBalances: [1e9, 10e9], postBalances: [1e9, 10e9], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: 'Spammer11111111111111111111111111111111111', signer: true }, { pubkey: WALLET, signer: false }] } } });
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', baseToken: { address: MEME, symbol: 'MEME' }, priceUsd: '0.0001', liquidity: { usd: 1e4 } }] }));
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const spam = Array.from({ length: 1000 }, (_, i) => ({ signature: i % 50 === 0 ? `okspam${i}-${Math.random()}` : `fail${i}-${Math.random()}`, err: i % 50 === 0 ? null : { x: 1 }, blockTime: t }));
      for (const x of spam) if (!x.err) txs.set(x.signature, spamTx(x.signature));
      result = [...own.map((signature) => ({ signature, err: null, blockTime: t })), ...spam].slice(0, body.params[1].limit);
    } else if (body.method === 'getBalance') result = { value: lamports };
    else if (body.method === 'getTokenAccountsByOwner') result = { value: [] };
    else if (body.method === 'getTransaction') {
      calls.getTransaction += 1;
      result = txs.get(body.params[0]) || null;
    } else if (body.method === 'getBlock') {
      calls.getBlock += 1;
      // the block the balance moved in: 300 spam transactions plus the wallet's own buy
      if (body.params[0] === 4 && txs.has('decuBuy')) {
        const spamEntries = Array.from({ length: 300 }, (_, i) => ({ meta: { err: null }, transaction: { signatures: [`blockspam${i}`], accountKeys: [{ pubkey: 'Spammer11111111111111111111111111111111111', signer: true }, { pubkey: WALLET, signer: false }] } }));
        result = { transactions: [...spamEntries.slice(0, 150), { meta: { err: null }, transaction: { signatures: ['decuBuy'], accountKeys: [{ pubkey: WALLET, signer: true }, { pubkey: 'Pool1111111111111111111111111111111111111111', signer: false }] } }, ...spamEntries.slice(150)] };
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const calls = { getTransaction: 0, getBlock: 0 };
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl, WebSocketImpl: FakeWS, rpcUrl: 'https://rpc.example', onSignal: (sg) => got.push(sg), pollIntervalMs: 3_600_000, tokenInfo: { get: async () => ({ symbol: 'MEME', priceUsd: 0.0001 }), solPriceUsd: async () => 200 } });
  w.setWallets([{ address: WALLET, label: 'decu' }]);
  w.start();
  await until(() => w.getStatus().stream.connected);
  await w.pollOnce(); // flood detected → balance mode + baseline
  await tick(400); // let the watcher's own first scheduled check run, so only the push can find the trade
  assert.equal(w.wallets.get(WALLET).mode, 'balances');
  const ws = FakeWS.all[0];
  await until(() => ws.sent.some((m) => m.method === 'accountSubscribe'));
  // the real buy lands: 1 SOL for 1M MEME, signed by the wallet
  const keys = [{ pubkey: WALLET, signer: true }, { pubkey: 'Pool1111111111111111111111111111111111111111', signer: false }, { pubkey: 'Acc11111111111111111111111111111111111111111', signer: false }];
  txs.set('decuBuy', { slot: 2, blockTime: t, meta: { err: null, fee: 5000, preBalances: [10e9, 1e9, 0], postBalances: [9e9 - 5000, 2e9, 0], preTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 } }], postTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '1000000000000', decimals: 6, uiAmount: 1e6 } }] }, transaction: { signatures: ['decuBuy'], message: { accountKeys: keys } } });
  own.unshift('decuBuy');
  lamports = 9e9 - 5000;
  const accReq = ws.sent.find((m) => m.method === 'accountSubscribe');
  const accSub = 100 + ws.sent.filter((m) => m.method === 'logsSubscribe' || m.method === 'accountSubscribe').indexOf(accReq);
  ws.reply({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: accSub, result: { context: { slot: 3 }, value: { lamports: 10e9 } } } }); // baseline
  const txReadsBefore = calls.getTransaction;
  ws.reply({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: accSub, result: { context: { slot: 4 }, value: { lamports } } } });
  await until(() => got.length > 0, 3000);
  assert.equal(got.length, 1, 'exactly the wallet’s own buy — signed spam from others is ignored');
  assert.equal(got[0].signature, 'decuBuy');
  assert.equal(got[0].via, 'stream');
  assert.ok(got[0].streamMs < 2000, `found ${got[0].streamMs} ms after the push`);
  assert.equal(calls.getBlock, 1, 'one block read for the move');
  const txOpensAfterPush = calls.getTransaction - txReadsBefore;
  assert.ok(txOpensAfterPush <= 2, `only the wallet's own transaction is opened, not the spam (${txOpensAfterPush} reads)`);
  w.stop();
});

test('S9 provider without accountSubscribe (Alchemy): balance watch moves to the public feed and still catches the trade', async () => {
  FakeWS.all = [];
  const t = Math.floor(Date.now() / 1000);
  let lamports = 10e9;
  const own = []; // signatures the wallet signed (newest first)
  const txs = new Map();
  const spamTx = (sig) => ({ slot: 1, blockTime: t, meta: { err: null, fee: 5000, preBalances: [1e9, 10e9], postBalances: [1e9, 10e9], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: 'Spammer11111111111111111111111111111111111', signer: true }, { pubkey: WALLET, signer: false }] } } });
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', baseToken: { address: MEME, symbol: 'MEME' }, priceUsd: '0.0001', liquidity: { usd: 1e4 } }] }));
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const spam = Array.from({ length: 1000 }, (_, i) => ({ signature: i % 50 === 0 ? `okspam${i}-${Math.random()}` : `fail${i}-${Math.random()}`, err: i % 50 === 0 ? null : { x: 1 }, blockTime: t }));
      for (const x of spam) if (!x.err) txs.set(x.signature, spamTx(x.signature));
      result = [...own.map((signature) => ({ signature, err: null, blockTime: t })), ...spam].slice(0, body.params[1].limit);
    } else if (body.method === 'getBalance') result = { value: lamports };
    else if (body.method === 'getTokenAccountsByOwner') result = { value: [] };
    else if (body.method === 'getTransaction') result = txs.get(body.params[0]) || null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl, WebSocketImpl: FakeWS, rpcUrl: 'https://noaccount.example', balanceWsUrl: 'wss://public.example', onSignal: (sg) => got.push(sg), pollIntervalMs: 3_600_000, tokenInfo: { get: async () => ({ symbol: 'MEME', priceUsd: 0.0001 }), solPriceUsd: async () => 200 } });
  w.setWallets([{ address: WALLET, label: 'decu' }]);
  w.start();
  await until(() => w.getStatus().stream.connected);
  await w.pollOnce(); // flood detected → balance mode + baseline
  await tick(400); // let the watcher's own first scheduled check run, so only the push can find the trade
  assert.equal(w.wallets.get(WALLET).mode, 'balances');
  await until(() => FakeWS.all.some((x) => x.url === 'wss://public.example' && x.sent.some((m) => m.method === 'accountSubscribe')));
  const ws = FakeWS.all.find((x) => x.url === 'wss://public.example');
  assert.equal(w.getStatus().stream.balanceFeed?.subscriptions, 1, 'flooded wallet watched on the public feed');
  // the real buy lands: 1 SOL for 1M MEME, signed by the wallet
  const keys = [{ pubkey: WALLET, signer: true }, { pubkey: 'Pool1111111111111111111111111111111111111111', signer: false }, { pubkey: 'Acc11111111111111111111111111111111111111111', signer: false }];
  txs.set('decuBuy', { slot: 2, blockTime: t, meta: { err: null, fee: 5000, preBalances: [10e9, 1e9, 0], postBalances: [9e9 - 5000, 2e9, 0], preTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 } }], postTokenBalances: [{ accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '1000000000000', decimals: 6, uiAmount: 1e6 } }] }, transaction: { signatures: ['decuBuy'], message: { accountKeys: keys } } });
  own.unshift('decuBuy');
  lamports = 9e9 - 5000;
  const accReq = ws.sent.find((m) => m.method === 'accountSubscribe');
  const accSub = 100 + ws.sent.filter((m) => m.method === 'logsSubscribe' || m.method === 'accountSubscribe').indexOf(accReq);
  ws.reply({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: accSub, result: { context: { slot: 3 }, value: { lamports: 10e9 } } } }); // baseline
  ws.reply({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: accSub, result: { context: { slot: 4 }, value: { lamports } } } });
  await until(() => got.length > 0, 3000);
  assert.equal(got.length, 1, 'exactly the wallet’s own buy — signed spam from others is ignored');
  assert.equal(got[0].signature, 'decuBuy');
  assert.equal(got[0].via, 'stream');
  assert.ok(got[0].streamMs < 2000, `found ${got[0].streamMs} ms after the push`);
  w.stop();
});

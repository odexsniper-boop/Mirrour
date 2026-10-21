// Integration tests: real CopyTradingEngine + LiveSignalService + watcher on a mocked
// Solana RPC / DexScreener. Verifies signals-only mode never trades.
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { LiveSignalService } from '../engine/liveSignals.mjs';
import { SolanaWalletWatcher, TokenInfoService, WSOL_MINT } from '../engine/walletWatcher.mjs';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MEME = 'MemeMint1111111111111111111111111111111pump';

function net({ priceNowMultiplier = 1.02 } = {}) {
  const sigs = [];
  const txs = new Map();
  const txPrice = 0.5 * 200 / 5_000_000; // 0.5 SOL @ $200 for 5M tokens = $0.00002
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) {
      const mint = String(url).split('/').pop();
      const pairs = mint === WSOL_MINT
        ? [{ chainId: 'solana', baseToken: { address: WSOL_MINT, symbol: 'SOL' }, priceUsd: '200', liquidity: { usd: 1e8 } }]
        : [{ chainId: 'solana', dexId: 'pumpfun', baseToken: { address: mint, symbol: 'MEME', name: 'Meme' }, priceUsd: String(txPrice * priceNowMultiplier), marketCap: 120000, liquidity: { usd: 30000 } }];
      return new Response(JSON.stringify({ pairs }), { status: 200 });
    }
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const [addr, o = {}] = body.params;
      let list = sigs.filter((s) => s.wallet === addr);
      if (o.until) { const i = list.findIndex((s) => s.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      result = list.slice(0, o.limit || 1000).map(({ signature }) => ({ signature, err: null }));
    } else if (body.method === 'getTransaction') {
      result = txs.get(body.params[0]);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const swap = (sig, wallet, side, { soldShare = 1, ageSec = 3, mint = MEME } = {}) => {
    const tok = { accountIndex: 2, mint, owner: wallet, uiTokenAmount: { amount: '5000000000000', decimals: 6 } };
    const zero = { ...tok, uiTokenAmount: { amount: String(Math.round(5000000000000 * (1 - soldShare))), decimals: 6 } };
    const tx = {
      slot: 1, blockTime: Math.floor(Date.now() / 1000) - ageSec,
      meta: {
        err: null, fee: 5000,
        preBalances: [5e9, 1e9, 0], postBalances: [side === 'buy' ? 5e9 - 0.5e9 - 5000 : 5e9 + 0.6e9 - 5000, 1e9, 0],
        preTokenBalances: side === 'buy' ? [zero] : [tok], postTokenBalances: side === 'buy' ? [tok] : [zero],
      },
      transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: wallet }, { pubkey: 'Pool111111111111111111111111111111111111111' }, { pubkey: 'Acc1111111111111111111111111111111111111111' }] } },
    };
    sigs.unshift({ signature: sig, wallet });
    txs.set(sig, tx);
  };
  return { fetchImpl, swap };
}

function setup(netOpts) {
  const n = net(netOpts);
  const engine = new CopyTradingEngine();
  engine.resetToCleanState();
  engine.settings.paperTrading = true;
  const watcher = new SolanaWalletWatcher({ fetchImpl: n.fetchImpl, backfillCount: 1, tokenInfo: new TokenInfoService({ fetchImpl: n.fetchImpl }) });
  const events = [];
  const live = new LiveSignalService({ engine, watcher, broadcast: (e) => events.push(e), env: {} });
  const follow = {
    id: 'fol-1', walletId: engine.getActiveWallet().id, name: 'frank', handle: 'whale1', traderWallet: WALLET,
    chainId: 'solana', status: 'copying', pauseReason: null, mode: 'auto-exit', sizing: { type: 'fixed', amount: 75 },
    tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 10000, consecutiveLosses: 0,
    exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  engine.follows.push(follow);
  live.sync();
  watcher.stop(); // drive polls manually in tests
  return { ...n, engine, watcher, live, events, follow };
}

test('L1 follows are watched automatically; manual wallets can be added and removed', () => {
  const { live } = setup();
  assert.deepEqual(live.watchList().map((w) => w.address), [WALLET]);
  live.addManual(OTHER, 'whale');
  assert.equal(live.watchList().length, 2);
  assert.throws(() => live.addManual('bad'), /valid Solana/);
  live.removeManual(OTHER);
  assert.equal(live.watchList().length, 1);
  live.watcher.stop();
});

test('L2 signals-only (copy off): a real buy is reported with a dry-run "would copy" decision and NOTHING is traded', async () => {
  const { live, engine, swap, watcher, events } = setup();
  live.updateConfig({ paperCopy: false });
  live.watcher.stop();
  await watcher.pollOnce(); // baseline (no history yet)
  swap('buy1', WALLET, 'buy');
  await watcher.pollOnce();
  assert.equal(live.signals.length, 1);
  const s = live.signals[0];
  assert.equal(s.side, 'buy');
  assert.equal(s.symbol, 'MEME');
  assert.equal(s.decisions[0].status, 'would_copy');
  assert.equal(s.decisions[0].sizeUsd, 75);
  assert.equal(engine.positions.length, 0, 'no position opened');
  assert.equal(engine.history.length, 0, 'nothing written to history');
  assert.equal(s.paperCopied, false);
  assert.ok(events.some((e) => e.event === 'live_signal'));
});

test('L3 decision explains skips: max chase uses the live price vs the trader fill', async () => {
  const { live, swap, watcher } = setup({ priceNowMultiplier: 1.6 }); // price ran +60% since the trader bought
  await watcher.pollOnce();
  swap('buy2', WALLET, 'buy');
  await watcher.pollOnce();
  const d = live.signals[0].decisions[0];
  assert.equal(d.status, 'skipped');
  assert.match(d.reason, /price moved too far/);
});

test('L4 paused follow and sells in Auto-Exit mode are reported as skipped, with reasons', async () => {
  const { live, swap, watcher, follow } = setup();
  await watcher.pollOnce();
  follow.status = 'paused';
  swap('buy3', WALLET, 'buy');
  swap('sell3', WALLET, 'sell');
  await watcher.pollOnce();
  const buy = live.signals.find((s) => s.side === 'buy');
  const sell = live.signals.find((s) => s.side === 'sell');
  assert.match(buy.decisions[0].reason, /paused/);
  assert.match(sell.decisions[0].reason, /Auto-Exit/);
});

test('L5 manually watched wallet shows "watch only"', async () => {
  const { live, swap, watcher } = setup();
  live.addManual(OTHER, 'whale');
  live.watcher.stop();
  await watcher.pollOnce();
  swap('w1', OTHER, 'buy');
  await watcher.pollOnce();
  const s = live.signals.find((x) => x.wallet === OTHER);
  assert.equal(s.decisions[0].status, 'watch_only');
  assert.equal(s.label, 'whale');
});

test('L6 paper-copy ON (and Paper Trading ON) opens a PAPER position on the real token', async () => {
  const { live, swap, watcher, engine } = setup();
  live.updateConfig({ paperCopy: true });
  live.watcher.stop();
  await watcher.pollOnce();
  swap('pc1', WALLET, 'buy');
  await watcher.pollOnce();
  assert.equal(live.signals[0].paperCopied, true);
  assert.equal(engine.positions.length, 1);
  assert.equal(engine.positions[0].tokenAddress, MEME);
  assert.equal(engine.positions[0].isPaper, true);
});

test('L7 paper-copy never runs when Paper Trading is OFF, and backfilled history is never copied', async () => {
  const { live, swap, watcher, engine } = setup();
  swap('old1', WALLET, 'buy'); // exists before watching starts → backfill
  live.updateConfig({ paperCopy: true });
  live.watcher.stop();
  await watcher.pollOnce();
  assert.equal(live.signals[0].backfill, true);
  assert.equal(engine.positions.length, 0);
  engine.settings.paperTrading = false;
  swap('live1', WALLET, 'buy');
  await watcher.pollOnce();
  assert.equal(engine.positions.length, 0);
});

test('L8 end-to-end mirror copy: trader buys → paper buy; trader sells → paper position closed into history', async () => {
  const { live, swap, watcher, engine, follow } = setup();
  follow.mode = 'mirror';
  live.updateConfig({ paperCopy: true });
  live.watcher.stop();
  await watcher.pollOnce();
  swap('e2e-buy', WALLET, 'buy');
  await watcher.pollOnce();
  assert.equal(engine.positions.filter((p) => p.remainingTokens > 0).length, 1, 'buy copied');
  const pos = engine.positions[0];
  assert.equal(pos.tokenAddress, MEME);
  assert.ok(pos.sizeUsd > 0 && pos.sizeUsd <= 75.01, `sized by follow: ${pos.sizeUsd}`);
  swap('e2e-sell', WALLET, 'sell');
  await watcher.pollOnce();
  assert.equal(live.signals[0].side, 'sell');
  assert.equal(pos.remainingTokens, 0, `sell copied (decision: ${JSON.stringify(live.signals[0].decisions)})`);
  assert.ok(engine.history.some((h) => /sell/i.test(h.type || h.side || '')), 'sell recorded in history');
});

async function copyOnce(opts, mutate) {
  const ctx = setup(opts);
  mutate?.(ctx);
  ctx.live.updateConfig({ paperCopy: true });
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('b1', WALLET, 'buy');
  await ctx.watcher.pollOnce();
  return ctx;
}

test('L9 copying is ON by default for followed wallets (Paper Trading on)', async () => {
  const { engine, live, swap, watcher } = setup();
  assert.equal(live.config.paperCopy, true);
  await watcher.pollOnce();
  swap('d1', WALLET, 'buy');
  await watcher.pollOnce();
  assert.equal(engine.positions.length, 1);
});

test('L10 sizing settings are applied: fixed, % of balance, proportional cap', async () => {
  const fixed = await copyOnce({}, ({ follow }) => { follow.sizing = { type: 'fixed', amount: 40 }; });
  assert.ok(Math.abs(fixed.engine.positions[0].sizeUsd - 40) < 0.01);

  const pct = await copyOnce({}, ({ follow, engine }) => { follow.sizing = { type: 'percent', amount: 10 }; });
  const pcost = pct.engine.positions[0]?.initialCostUsd;
  assert.ok(pcost > 0, 'percent sizing produced a position');

  // trader spent 0.5 SOL ≈ $100: proportional with cap 60 → $60, cap 500 → trader size
  const capped = await copyOnce({}, ({ follow }) => { follow.sizing = { type: 'proportional', amount: 60 }; });
  assert.ok(Math.abs(capped.engine.positions[0].sizeUsd - 60) < 0.01);
  const full = await copyOnce({}, ({ follow }) => { follow.sizing = { type: 'proportional', amount: 500 }; });
  assert.ok(Math.abs(full.engine.positions[0].initialCostUsd - 100) < 1, `got ${full.engine.positions[0].initialCostUsd}`);
});

test('L11 TP / SL from the follow are carried onto the copied position and fire', async () => {
  const { engine } = await copyOnce({}, ({ follow }) => { follow.mode = 'buy-and-hold'; follow.tpPct = 50; follow.slPct = 20; });
  const pos = engine.positions[0];
  pos.currentPriceUsd = pos.entryPriceUsd * 0.75;
  await engine.evaluatePositionExits(pos, Date.now());
  assert.equal(pos.remainingTokens, 0, 'stop loss closed it');
});

test('L12 paused follow is not copied; max chase skips a buy that ran too far', async () => {
  const paused = await copyOnce({}, ({ follow }) => { follow.status = 'paused'; });
  assert.equal(paused.engine.positions.length, 0);
  assert.match(paused.live.signals[0].copies[0].reason, /paused/);

  const chased = await copyOnce({ priceNowMultiplier: 1.6 });
  assert.equal(chased.engine.positions.length, 0);
  assert.match(chased.live.signals[0].copies[0].reason, /moved too far/);
});

test('L13 two follows with the same name only copy their own wallet', async () => {
  const ctx = setup();
  const other = { ...ctx.follow, id: 'fol-2', traderWallet: OTHER, handle: ctx.follow.handle, name: ctx.follow.name, exitRules: createDefaultExitRules() };
  ctx.engine.follows.push(other);
  ctx.live.sync();
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('own1', WALLET, 'buy');
  await ctx.watcher.pollOnce();
  assert.equal(ctx.engine.positions.length, 1);
  assert.equal(ctx.engine.positions[0].followId, 'fol-1');
});

test('L14 Mirror mode copies a partial sell with the same share', async () => {
  const ctx = setup();
  ctx.follow.mode = 'mirror';
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('pb', WALLET, 'buy');
  await ctx.watcher.pollOnce();
  const pos = ctx.engine.positions[0];
  const start = pos.remainingTokens;
  ctx.swap('ps', WALLET, 'sell', { soldShare: 0.5 });
  await ctx.watcher.pollOnce();
  assert.ok(Math.abs(pos.remainingTokens / start - 0.5) < 0.01, `remaining ${pos.remainingTokens / start}`);
});

test('L15 open positions are priced live in ONE batched call, from the deepest pool', async () => {
  const { engine, live, watcher, swap } = setup();
  live.watcher.stop();
  await watcher.pollOnce();
  swap('px1', WALLET, 'buy');
  await watcher.pollOnce();
  const pos = engine.positions[0];
  // this test is about batching + pool choice: forget the mock trade's price so the feed applies
  engine.lastTradePrice?.clear();
  const calls = [];
  engine.priceFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ pairs: [
      { baseToken: { address: MEME }, priceUsd: '0.5', liquidity: { usd: 100 } },
      { baseToken: { address: MEME }, priceUsd: '0.00003', marketCap: 150000, liquidity: { usd: 50000 } },
      { baseToken: { address: 'SomethingElse' }, priceUsd: '9', liquidity: { usd: 1e9 } },
    ] }));
  };
  await engine.tickMarketPrices();
  assert.equal(calls.length, 1);
  assert.equal(pos.currentPriceUsd, 0.00003);
  assert.equal(pos.currentMarketCapUsd, 150000);
});

test('L16 a flooded wallet (balance mode, verified) is still copied with the follow settings', async () => {
  const t = Math.floor(Date.now() / 1000);
  let holdings = { sol: 10e9, tokens: [] };
  const txs = new Map();
  const accSigs = [];
  const swapTx = (sig, side) => {
    const tok = { accountIndex: 2, mint: MEME, owner: WALLET, uiTokenAmount: { amount: '1000000000000', decimals: 6 } };
    const zero = { ...tok, uiTokenAmount: { amount: '0', decimals: 6 } };
    txs.set(sig, { slot: 1, blockTime: t, meta: { err: null, fee: 5000, preBalances: [side === 'buy' ? 10e9 : 9e9], postBalances: [side === 'buy' ? 9e9 : 10e9], preTokenBalances: side === 'buy' ? [zero] : [tok], postTokenBalances: side === 'buy' ? [tok] : [zero] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } });
    accSigs.unshift({ signature: sig, err: null, blockTime: t });
  };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) {
      return new Response(JSON.stringify({ pairs: [{ chainId: 'solana', baseToken: { address: MEME, symbol: 'MEME' }, priceUsd: '0.0002', marketCap: 200000, liquidity: { usd: 40000 } }] }));
    }
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') result = body.params[0] === 'accMEME' ? accSigs : [...accSigs, ...Array.from({ length: body.params[1].limit }, (_, i) => ({ signature: `x${i}${Math.random()}`, err: {}, blockTime: t }))].slice(0, body.params[1].limit);
    else if (body.method === 'getBalance') result = { value: holdings.sol };
    else if (body.method === 'getTokenAccountsByOwner') result = { value: body.params[1].programId.startsWith('Tokenkeg') ? holdings.tokens.map(([mint, amount]) => ({ pubkey: 'accMEME', account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals: 6 } } } } } })) : [] };
    else if (body.method === 'getTransaction') result = txs.get(body.params[0]) || null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const engine = new CopyTradingEngine();
  engine.resetToCleanState();
  engine.settings.paperTrading = true;
  const watcher = new SolanaWalletWatcher({ fetchImpl, tokenInfo: { get: async () => ({ symbol: 'MEME', priceUsd: 0.0002, marketCapUsd: 200000, liquidityUsd: 40000, dexId: 'raydium' }), solPriceUsd: async () => 200 } });
  const live = new LiveSignalService({ engine, watcher, broadcast: () => {}, env: {} });
  engine.follows.push({ id: 'fb', walletId: engine.getActiveWallet().id, name: 'busy', handle: 'busy', traderWallet: WALLET, chainId: 'solana', status: 'copying', mode: 'mirror', sizing: { type: 'fixed', amount: 30 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 10, maxAtRiskUsd: 1000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {} });
  live.sync();
  watcher.stop();
  await watcher.pollOnce();
  swapTx('vbuy', 'buy');
  holdings = { sol: 9e9, tokens: [[MEME, 1_000_000_000_000]] };
  await watcher.pollOnce();
  assert.equal(engine.positions.length, 1);
  assert.ok(Math.abs(engine.positions[0].sizeUsd - 30) < 0.01);
  swapTx('vsell', 'sell');
  holdings = { sol: 10e9, tokens: [] };
  await watcher.pollOnce();
  assert.equal(engine.positions[0].remainingTokens, 0, 'mirror sell copied');
});

import { pickCurrentPrice } from '../engine/liveSignals.mjs';

test('L17 prices: real fills beat a market quote that is >3× off; mirror sells use the trader fill', async () => {
  assert.equal(pickCurrentPrice({ side: 'buy', txPriceUsd: 1, currentPriceUsd: 1.2 }), 1.2);
  assert.equal(pickCurrentPrice({ side: 'buy', txPriceUsd: 1, currentPriceUsd: 24 }), 1, 'mispriced feed ignored');
  assert.equal(pickCurrentPrice({ side: 'sell', txPriceUsd: 1, currentPriceUsd: 24 }), 1);

  const ctx = setup();
  ctx.follow.mode = 'mirror';
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('p1', WALLET, 'buy');
  await ctx.watcher.pollOnce();
  const pos = ctx.engine.positions[0];
  const fill = pos.entryPriceUsd;
  // the market feed suddenly claims 20× — no recent real fill disagrees? the buy itself is one
  ctx.engine.priceFetch = async () => new Response(JSON.stringify({ pairs: [{ baseToken: { address: MEME }, priceUsd: String(fill * 20), liquidity: { usd: 9e4 } }] }));
  await ctx.engine.tickMarketPrices();
  assert.ok(pos.currentPriceUsd < fill * 3, `feed spike ignored (${pos.currentPriceUsd / fill}×)`);
  ctx.swap('s1', WALLET, 'sell');
  await ctx.watcher.pollOnce();
  const sell = ctx.engine.history.find((h) => h.side === 'sell' && h.status === 'filled');
  assert.ok(sell, 'mirror sell filled');
  assert.ok(Math.abs(sell.pnlPct) < 60, `realistic PnL, got ${sell.pnlPct}%`);
});


test('L18 a busy wallet: 40 trades between two polls are all read (none dropped)', async () => {
  const ctx = setup();
  ctx.live.updateConfig({ paperCopy: false });
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  for (let i = 0; i < 40; i++) ctx.swap(`burst${i}`, WALLET, i % 2 ? 'sell' : 'buy');
  await ctx.watcher.pollOnce();
  assert.equal(ctx.live.signals.length, 40);
});

test('L19 a buy detected too late (watcher fell behind) is not copied at a stale price', async () => {
  const ctx = setup();
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('late1', WALLET, 'buy', { ageSec: 300 });
  await ctx.watcher.pollOnce();
  assert.equal(ctx.engine.positions.length, 0);
  assert.match(ctx.live.signals[0].copies[0].reason, /too old to copy/);
});

test('L20 mirror sell only sells the exact token, never another token with the same ticker', async () => {
  const OTHER_MINT = 'MemeMint2222222222222222222222222222222pump';
  const ctx = setup();
  ctx.follow.mode = 'mirror';
  ctx.live.watcher.stop();
  await ctx.watcher.pollOnce();
  ctx.swap('a1', WALLET, 'buy');
  await ctx.watcher.pollOnce();
  ctx.engine.settings.cooldown.mode = 'off';
  ctx.swap('a2', WALLET, 'buy', { mint: OTHER_MINT }); // same "MEME" symbol from the mocked feed
  await ctx.watcher.pollOnce();
  const [p1, p2] = [ctx.engine.positions.find((p) => p.tokenAddress === MEME), ctx.engine.positions.find((p) => p.tokenAddress === OTHER_MINT)];
  assert.ok(p1 && p2, 'two positions, same ticker');
  ctx.swap('a3', WALLET, 'sell', { mint: OTHER_MINT });
  await ctx.watcher.pollOnce();
  assert.equal(p2.remainingTokens, 0);
  assert.ok(p1.remainingTokens > 0, 'the other token was not touched');
});

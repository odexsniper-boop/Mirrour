// Copy speed: pump.fun coins never wait for DexScreener; other coins keep the normal budget.
// Run: node --test test/copy-speed.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SolanaWalletWatcher, PUMP_CURVE_PROGRAM, PUMP_SUPPLY, isPumpFunCoin } from '../engine/walletWatcher.mjs';
import { WalletStream } from '../engine/walletStream.mjs';
import { TokenAccountStream } from '../engine/tokenStream.mjs';
import { RealTrader, WSOL_MINT } from '../engine/realTrader.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';

const WALLET = '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ';

function buyTx(mint, venueProgram = PUMP_CURVE_PROGRAM) {
  const tok = { accountIndex: 2, mint, owner: WALLET, uiTokenAmount: { amount: '5000000000000', decimals: 6 } }; // 5M tokens
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0, 1], postBalances: [4.5e9 - 5000, 0, 0, 1], preTokenBalances: [{ ...tok, uiTokenAmount: { amount: '0', decimals: 6 } }], postTokenBalances: [tok] },
    transaction: { signatures: ['x'], message: { accountKeys: [{ pubkey: WALLET }, { pubkey: 'Pool111111111111111111111111111111111111111' }, { pubkey: 'Acc1111111111111111111111111111111111111111' }, { pubkey: venueProgram }] } },
  };
}

function watcher(slowMs) {
  const got = [];
  const w = new SolanaWalletWatcher({
    fetchImpl: async () => new Response('{}'),
    tokenInfo: { get: () => new Promise((r) => setTimeout(() => r({ symbol: 'LATE', marketCapUsd: 123 }), slowMs)), solPriceUsd: async () => 200 },
    onSignal: (s) => got.push(s),
  });
  w.onTokenInfoLate = () => {};
  return { w, got };
}

test('S1 pump.fun buy: no wait for token details; market cap from the fill price × 1B; authorities known', async () => {
  const mint = 'Fast1111111111111111111111111111111111pump';
  const { w, got } = watcher(2000);
  w.tokenInfoBudgetMs = 1200;
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sigp1', { tx: buyTx(mint) });
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `signal ready in ${ms} ms (pump.fun budget is 150 ms)`);
  const s = got[0];
  assert.ok(s, 'signal emitted');
  assert.equal(s.venue, 'pumpfun');
  // 0.5 SOL × $200 for 5M tokens = $0.00002 per token → $20,000 market cap
  assert.ok(Math.abs(s.marketCapUsd - s.txPriceUsd * PUMP_SUPPLY) < 1e-6);
  assert.ok(s.marketCapUsd > 19_000 && s.marketCapUsd < 21_000, `mcap ${s.marketCapUsd}`);
  assert.equal(s.authorityKnown, true);
  assert.equal(s.mintAuthority, null);
  assert.equal(s.freezeAuthority, null);
});

test('S2 a non-pump.fun coin keeps the normal token-details wait (safety data matters there)', async () => {
  const mint = 'Slow11111111111111111111111111111111111111';
  const { w, got } = watcher(2000);
  w.tokenInfoBudgetMs = 300;
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'x' }, 'sign1', { tx: buyTx(mint, 'OtherDex11111111111111111111111111111111111') });
  const ms = Date.now() - t0;
  assert.ok(ms >= 280, `waited the normal budget (${ms} ms)`);
  assert.equal(got[0]?.marketCapUsd ?? null, null, 'no guessed market cap for unknown coins');
  assert.equal(got[0]?.authorityKnown, false);
});

test('S3 isPumpFunCoin needs both the pump suffix and a pump.fun venue', () => {
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: 'pumpfun' }), true);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: 'pumpswap' }), true);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: null }), false);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcbonk', venue: 'pumpfun' }), false);
});

test('S4 cached token details still win when they arrive in time', async () => {
  const mint = 'Cach1111111111111111111111111111111111pump';
  const { w, got } = watcher(10);
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sigc1', { tx: buyTx(mint) });
  assert.equal(got[0].symbol, 'LATE');
  assert.equal(got[0].marketCapUsd, 123, 'real feed value used when available');
});

test('S5 streams default to processed commitment for sub-second push detection', () => {
  const ws = new WalletStream({ url: 'wss://x' });
  const ts = new TokenAccountStream({ url: 'wss://x' });
  assert.equal(ws.commitment, 'processed');
  assert.equal(ts.commitment, 'processed');
});

test('S6 multi-RPC race resolves pushed transaction from the fastest provider in milliseconds', async () => {
  const mint = 'Race1111111111111111111111111111111111pump';
  const got = [];
  const w = new SolanaWalletWatcher({
    rpcUrl: 'https://slow-alchemy.example',
    fastRpcUrls: ['https://fast-helius.example'],
    fetchImpl: async (url) => {
      if (String(url).includes('slow-alchemy')) {
        // Primary RPC lags behind the push and returns null first
        await new Promise((r) => setTimeout(r, 400));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
      }
      // Fast Helius RPC already indexed the tx
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: buyTx(mint) }));
    },
    tokenInfo: { get: async () => null, solPriceFast: async () => 200 },
    onSignal: (s) => got.push(s),
  });
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sig-race', { via: 'stream', waitForTx: true });
  const ms = Date.now() - t0;
  assert.equal(got.length, 1);
  assert.equal(got[0].tokenDecimals, 6, 'decimals extracted directly from trader tx');
  assert.ok(ms < 100, `resolved from fast RPC in ${ms} ms without waiting 400 ms for slow RPC`);
});

test('S7 RealTrader skips getTokenSupply when token.decimals is known and blasts sendTransaction (skipPreflight) to fastRpcUrls', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const fakeV0Tx = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from([0x80, 1, 0, 1, 2]),
    pub,
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    Buffer.from([0, 0]),
  ]).toString('base64');

  let supplyCalls = 0;
  const blasted = [];
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    fastRpcUrls: ['https://helius.example', 'https://mainnet.block-engine.jito.wtf/api/v1/transactions'],
    rpc: async (method) => {
      if (method === 'getTokenSupply') supplyCalls += 1;
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getTransaction') return null;
      throw new Error(`unexpected ${method}`);
    },
    fetchImpl: async (url, opts = {}) => {
      if (String(url).includes('/order')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: fakeV0Tx, requestId: 'r1', inAmount: '100000000', outAmount: '500000000000', router: 'metis' }) };
      }
      if (String(url).includes('/execute')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, signature: 'sig123', totalInputAmount: '100000000', totalOutputAmount: '500000000000' }) };
      }
      blasted.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'sig123' }) };
    },
  });

  const token = { address: 'MintWithKnownDec11111111111111111111111pump', decimals: 6, symbol: 'FAST', currentPriceUsd: 0.00004 };
  const q = await trader.quote({ side: 'buy', token, amountUsd: 20, slippagePct: 10, assetMode: 'native' });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 20, quote: q, slippagePct: 10, assetMode: 'native' });
  assert.equal(r.ok, true);
  assert.equal(supplyCalls, 0, 'zero getTokenSupply RPC calls when decimals known from trader tx');
  assert.equal(blasted.length, 2, 'signed tx blasted to Helius and Jito in parallel');
  assert.equal(blasted[0].body.method, 'sendTransaction');
  assert.equal(blasted[0].body.params[1].skipPreflight, true);
});

test('S8 single-pass slippage pre-capping avoids double Jupiter quote when post-trader price is already known', async () => {
  CHAINS.solana.nativePriceUsd = 200;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const fakeV0Tx = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from([0x80, 1, 0, 1, 2]),
    pub,
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    Buffer.from([0, 0]),
  ]).toString('base64');

  let orderCalls = 0;
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method) => {
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getTransaction') return null;
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/order')) {
        orderCalls += 1;
        // Price is 0.000022 (+10% above trader's 0.00002)
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: fakeV0Tx, requestId: 'r1', inAmount: '250000000', outAmount: String(Math.floor((50 / 0.000022) * 1e6)), router: 'metis' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, signature: 'sigFast', totalInputAmount: '250000000', totalOutputAmount: String(Math.floor((50 / 0.000022) * 1e6)) }) };
    },
  });

  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  e.settings.cooldown.enabled = false;
  e.settings.tradingAsset.solana = 'native';
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => true;
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-fast', walletId: e.getActiveWallet().id, name: 't', handle: 't', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'auto-exit', sizing: { type: 'fixed', amount: 50 }, maxChasePct: 20,
    minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);

  const [res] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 't', traderWallet: WALLET, traderBuyUsd: 100, signature: 'sig-pre',
    token: {
      address: 'SinglePass11111111111111111111111111111pump', decimals: 6, symbol: 'SP', name: 'SP',
      isLaunchpad: true, stage: 'pre-grad', marketCapUsd: 22000,
      traderFillPriceUsd: 0.00002, currentPriceUsd: 0.000022, safety: { safetyVerified: true },
    },
  });
  assert.equal(res.status, 'filled');
  assert.equal(orderCalls, 1, 'executed in a single Jupiter quote pass');
});

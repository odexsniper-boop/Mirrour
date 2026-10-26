// Copy speed: pump.fun coins never wait for DexScreener; other coins keep the normal budget.
// Run: node --test test/copy-speed.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SolanaWalletWatcher, PUMP_CURVE_PROGRAM, PUMP_SUPPLY, isPumpFunCoin } from '../engine/walletWatcher.mjs';

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

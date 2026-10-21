// Alchemy integration tests — offline, with a dummy key and a mocked network.
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadEnvFile, maskSecret, redact } from '../engine/env.mjs';
import { AlchemyService, parseDasAsset, normalizeImageUrl } from '../engine/alchemy.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { LiveSignalService } from '../engine/liveSignals.mjs';
import { SolanaWalletWatcher, TokenInfoService, WSOL_MINT, DEFAULT_SOLANA_RPC } from '../engine/walletWatcher.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'alch_TESTKEY0000000000xyz';
const MINT = 'MemeMint1111111111111111111111111111111pump';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

test('A1 .env parsing: comments, quotes, export, inline comments; real env wins', () => {
  const parsed = parseEnv('# c\nALCHEMY_API_KEY=abc123\nexport PORT="4000"\nX=\'q v\'\nY=1 # note\nbad line\n');
  assert.deepEqual(parsed, { ALCHEMY_API_KEY: 'abc123', PORT: '4000', X: 'q v', Y: '1' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odexenv-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'A=1\nB=2\n');
  const env = { B: 'keep' };
  const r = loadEnvFile(f, env);
  assert.equal(env.A, '1');
  assert.equal(env.B, 'keep');
  assert.deepEqual(r.keys, ['A']);
  assert.equal(loadEnvFile(path.join(dir, 'missing'), {}).loaded, false);
});

test('A2 key masking and redaction', () => {
  assert.equal(maskSecret(KEY), 'alch_TE…yz');
  assert.equal(redact(`https://x/v2/${KEY}`, KEY), 'https://x/v2/alch_TE…yz');
  assert.equal(redact('nothing', ''), 'nothing');
});

test('A3 DAS asset parsing: image from links / files, authorities only when present, ipfs → https', () => {
  const a = parseDasAsset({
    content: { metadata: { name: 'Meme', symbol: 'MEME' }, links: { image: 'ipfs://bafy123/logo.png' } },
    token_info: { decimals: 6, supply: 1e15, mint_authority: null, freeze_authority: 'FrzAuth111' },
  });
  assert.equal(a.symbol, 'MEME');
  assert.equal(a.imageUrl, 'https://ipfs.io/ipfs/bafy123/logo.png');
  assert.equal(a.authorityKnown, true);
  assert.equal(a.freezeAuthority, 'FrzAuth111');
  assert.equal(a.mintAuthority, null);

  const b = parseDasAsset({ content: { metadata: { symbol: 'B' }, files: [{ uri: 'https://arweave.net/x', cdn_uri: 'https://cdn.example/x.png', mime: 'image/png' }] } });
  assert.equal(b.imageUrl, 'https://cdn.example/x.png');
  assert.equal(b.authorityKnown, false, 'no token_info → authority unknown, not "safe"');
  assert.equal(normalizeImageUrl('javascript:alert(1)'), null);
  assert.equal(normalizeImageUrl('ar://abc'), 'https://arweave.net/abc');
});

function mockAlchemy({ namedRejected = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, method: body.method, params: body.params });
    if (url.startsWith('https://solana-mainnet.g.alchemy.com/v2/')) {
      if (body.method === 'getAsset') {
        if (namedRejected && !Array.isArray(body.params)) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params' } }), { status: 200 });
        }
        const id = Array.isArray(body.params) ? body.params[0] : body.params.id;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          id, content: { metadata: { name: 'Meme Coin', symbol: 'MEME' }, links: { image: 'https://img.example/meme.png' } },
          token_info: { decimals: 6, mint_authority: null, freeze_authority: 'Frz111' },
        } }), { status: 200 });
      }
    }
    if (url.startsWith('https://bnb-mainnet.g.alchemy.com/v2/') && body.method === 'alchemy_getTokenMetadata') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { name: 'Cake', symbol: 'CAKE', decimals: 18, logo: 'https://logo.example/cake.png' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('A4 Solana token metadata via getAsset, cached; falls back to positional params if named are rejected', async () => {
  const { fetchImpl, calls } = mockAlchemy({ namedRejected: true });
  const al = new AlchemyService({ apiKey: KEY, fetchImpl });
  const t = await al.getSolanaToken(MINT);
  assert.equal(t.symbol, 'MEME');
  assert.equal(t.imageUrl, 'https://img.example/meme.png');
  assert.equal(t.freezeAuthority, 'Frz111');
  assert.equal(al.dasParamStyle, 'positional');
  const n = calls.length;
  await al.getSolanaToken(MINT);
  assert.equal(calls.length, n, 'second lookup served from cache');
  assert.ok(calls.every((c) => c.url.endsWith(KEY)), 'key only used in the server-side URL');
});

test('A5 BSC token logo via alchemy_getTokenMetadata; unknown chains return null', async () => {
  const { fetchImpl } = mockAlchemy();
  const al = new AlchemyService({ apiKey: KEY, fetchImpl });
  const t = await al.getToken('bsc', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82');
  assert.equal(t.symbol, 'CAKE');
  assert.equal(t.imageUrl, 'https://logo.example/cake.png');
  assert.equal(await al.getToken('arc', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'), null);
});

test('A6 disabled without a key: no calls, status says not configured', async () => {
  const { fetchImpl, calls } = mockAlchemy();
  const al = new AlchemyService({ apiKey: '', fetchImpl });
  assert.equal(await al.getSolanaToken(MINT), null);
  assert.equal(calls.length, 0);
  assert.equal(al.status().configured, false);
  assert.equal(al.solanaRpcUrl(), null);
});

test('A7 live signals: Alchemy becomes the default RPC and the key never appears in browser-bound data', () => {
  const engine = new CopyTradingEngine();
  const al = new AlchemyService({ apiKey: KEY, fetchImpl: mockAlchemy().fetchImpl });
  const live = new LiveSignalService({ engine, alchemy: al, env: {}, broadcast: () => {} });
  assert.ok(live.config.rpcUrl.endsWith(KEY));
  const snap = live.snapshot(true);
  assert.equal(snap.config.rpcProvider, 'alchemy');
  assert.ok(!JSON.stringify(snap).includes(KEY), 'snapshot must not contain the raw key');
  assert.ok(snap.config.rpcUrl.includes('…'));
  // Saving the masked URL from the UI keeps the real one
  live.updateConfig({ rpcUrl: snap.config.rpcUrl });
  assert.ok(live.config.rpcUrl.endsWith(KEY));
  live.updateConfig({ rpcUrl: DEFAULT_SOLANA_RPC });
  assert.equal(live.rpcProvider(), 'public');
  live.updateConfig({ rpcUrl: 'alchemy' });
  assert.equal(live.rpcProvider(), 'alchemy');
  live.watcher.stop();
});

test('A8 SOLANA_RPC_URL in the environment still takes priority over Alchemy', () => {
  const engine = new CopyTradingEngine();
  const al = new AlchemyService({ apiKey: KEY });
  const live = new LiveSignalService({ engine, alchemy: al, env: { SOLANA_RPC_URL: 'https://my-rpc.example' }, broadcast: () => {} });
  assert.equal(live.config.rpcUrl, 'https://my-rpc.example');
  assert.equal(live.rpcProvider(), 'custom');
});

test('A9 signals carry the token logo, and an active freeze authority makes the dry run skip the copy', async () => {
  const net = mockAlchemy();
  const sigs = [];
  const txs = new Map();
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) {
      const mint = String(url).split('/').pop();
      const pairs = mint === WSOL_MINT
        ? [{ chainId: 'solana', baseToken: { address: WSOL_MINT, symbol: 'SOL' }, priceUsd: '200', liquidity: { usd: 1e8 } }]
        : [{ chainId: 'solana', dexId: 'raydium', baseToken: { address: mint, symbol: 'MEME' }, priceUsd: '0.00002', marketCap: 90000, liquidity: { usd: 30000 } }];
      return new Response(JSON.stringify({ pairs }), { status: 200 });
    }
    if (String(url).includes('alchemy.com')) {
      const body = JSON.parse(opts.body);
      if (body.method === 'getAsset') return net.fetchImpl(url, opts);
    }
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const o = body.params[1] || {};
      let list = [...sigs];
      if (o.until) { const i = list.findIndex((x) => x.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      result = list.slice(0, o.limit || 100);
    } else if (body.method === 'getTransaction') result = txs.get(body.params[0]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const engine = new CopyTradingEngine();
  engine.resetToCleanState();
  engine.follows.push({ id: 'f1', walletId: engine.getActiveWallet().id, name: 'x', handle: 'x', traderWallet: WALLET, chainId: 'solana', status: 'copying', mode: 'auto-exit', sizing: { type: 'fixed', amount: 75 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 10, maxAtRiskUsd: 1000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {} });
  const al = new AlchemyService({ apiKey: KEY, fetchImpl });
  const watcher = new SolanaWalletWatcher({ fetchImpl, backfillCount: 1, rpcUrl: al.solanaRpcUrl(), tokenInfo: new TokenInfoService({ fetchImpl, metadata: al }) });
  const live = new LiveSignalService({ engine, watcher, alchemy: al, env: {}, broadcast: () => {} });
  live.sync();
  watcher.stop();
  const tok = { accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '5000000000000', decimals: 6 } };
  sigs.unshift({ signature: 'z1', err: null });
  txs.set('z1', { slot: 1, blockTime: Math.floor(Date.now() / 1000), meta: { err: null, fee: 5000, preBalances: [5e9], postBalances: [5e9 - 0.5e9 - 5000], preTokenBalances: [{ ...tok, uiTokenAmount: { amount: '0', decimals: 6 } }], postTokenBalances: [tok] }, transaction: { signatures: ['z1'], message: { accountKeys: [{ pubkey: WALLET }] } } });
  await watcher.pollOnce();
  const s = live.signals[0];
  assert.equal(s.imageUrl, 'https://img.example/meme.png');
  assert.equal(s.authorityKnown, true);
  assert.equal(s.freezeAuthority, 'Frz111');
  assert.equal(s.decisions[0].status, 'skipped');
  assert.match(s.decisions[0].reason, /safety filter/);
});

import { pickWalletAvatar } from '../engine/alchemy.mjs';

test('A-avatar picks a real collection NFT and skips compressed / spam / image-less items', () => {
  const nft = (o) => ({ interface: 'V1_NFT', burnt: false, compression: { compressed: false }, grouping: [{ group_key: 'collection', group_value: 'COLL', verified: true }], creators: [{ verified: true }], content: { metadata: { name: 'Mad Lad #1' }, links: { image: 'https://img.example/1.png' } }, id: 'mint1', ...o });
  assert.equal(pickWalletAvatar([]), null);
  assert.equal(pickWalletAvatar([nft({ compression: { compressed: true } })]), null, 'compressed (airdrop spam) skipped');
  assert.equal(pickWalletAvatar([nft({ content: { metadata: { name: 'Claim 500 SOL at scam.xyz' }, links: { image: 'https://x/y.png' } } })]), null, 'spam names skipped');
  assert.equal(pickWalletAvatar([nft({ content: { metadata: { name: 'No pic' } } })]), null, 'needs an image');
  assert.equal(pickWalletAvatar([nft({ interface: 'FungibleToken' })]), null, 'tokens are not pictures');
  const unverified = nft({ grouping: [{ group_key: 'collection', group_value: 'U', verified: false }], creators: [], content: { metadata: { name: 'meh' }, links: { image: 'https://img.example/u.png' } } });
  const r = pickWalletAvatar([unverified, nft()]);
  assert.equal(r.imageUrl, 'https://img.example/1.png', 'verified collection wins');
  assert.equal(r.source, 'nft');
});

test('A-retry retries 503/429, limits concurrency and only counts lasting failures', async () => {
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  const seen = new Map();
  const fetchImpl = async (_u, opts) => {
    calls += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const { id, params } = JSON.parse(opts.body);
    seen.set(params.n, (seen.get(params.n) || 0) + 1);
    if (seen.get(params.n) === 1) return { ok: false, status: params.n % 2 ? 503 : 429, json: async () => ({}) }; // first try of each request fails
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result: { ok: true } }) };
  };
  const a = new AlchemyService({ apiKey: 'k_test_1234567890', fetchImpl });
  a.retryDelaysMs = [1, 1];
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) => a.rpc('https://x', 'getAsset', { n })));
  assert.ok(results.every((r) => r.ok), 'every call succeeded after retrying');
  assert.equal(calls, 20, 'each request retried once');
  assert.ok(peak <= 4, `at most 4 requests at once (peak ${peak})`);
  assert.equal(a.status().consecutiveFailures, 0);

  const down = new AlchemyService({ apiKey: 'k_test_1234567890', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  down.retryDelaysMs = [1, 1];
  await assert.rejects(down.rpc('https://x', 'getAsset', {}), /503/);
  assert.equal(down.status().consecutiveFailures, 1);
});

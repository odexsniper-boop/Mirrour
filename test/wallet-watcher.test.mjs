// Tests for the signals-only Solana wallet watcher. Runs offline: transactions are built in
// the exact shape `getTransaction` returns with encoding "jsonParsed", and RPC/DexScreener
// calls go to an in-memory mock.
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSwapFromTransaction,
  SolanaWalletWatcher,
  TokenInfoService,
  WSOL_MINT,
} from '../engine/walletWatcher.mjs';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MEME = 'MemeMint1111111111111111111111111111111pump';
const MEME2 = 'OtherMint222222222222222222222222222222pump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = 'Pool1111111111111111111111111111111111111111';
const FEE = 5000;

const tb = (accountIndex, mint, owner, amount, decimals = 6) => ({
  accountIndex,
  mint,
  owner,
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  uiTokenAmount: { amount: String(amount), decimals, uiAmount: amount / 10 ** decimals, uiAmountString: String(amount / 10 ** decimals) },
});

function makeTx({ sig = 'SIG' + Math.random().toString(36).slice(2), solPre = 5e9, solPost = 5e9, pre = [], post = [], err = null, payer = WALLET, blockTime = 1_790_000_000 } = {}) {
  const keys = [payer, POOL, 'WalletTokenAcc1111111111111111111111111111', 'WalletTokenAcc2222222222222222222222222222', 'PoolTokenAcc11111111111111111111111111111'];
  if (payer !== WALLET) keys.push(WALLET);
  const preBalances = keys.map((k) => (k === WALLET ? solPre : 1e9));
  const postBalances = keys.map((k) => (k === WALLET ? solPost : 1e9));
  return {
    slot: 300_000_000,
    blockTime,
    meta: { err, fee: FEE, preBalances, postBalances, preTokenBalances: pre, postTokenBalances: post },
    transaction: {
      signatures: [sig],
      message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true, source: 'transaction' })) },
    },
  };
}

test('W1 pump.fun style buy: SOL out, new token account, meme tokens in', () => {
  // spent 1 SOL + fee + new-ATA rent; received 2,000,000 tokens (6 decimals)
  const tx = makeTx({
    solPre: 5e9,
    solPost: 5e9 - 1e9 - FEE - 2_039_280,
    pre: [tb(4, MEME, POOL, 900_000_000_000_000)],
    post: [tb(2, MEME, WALLET, 2_000_000_000_000), tb(4, MEME, POOL, 898_000_000_000_000)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'buy');
  assert.equal(s.tokenMint, MEME);
  assert.equal(s.tokenAmount, 2_000_000);
  assert.equal(s.quoteSymbol, 'SOL');
  assert.ok(Math.abs(s.quoteAmount - 1) < 1e-9, `quote ${s.quoteAmount}`); // rent + fee excluded
  assert.ok(Math.abs(s.priceInQuote - 5e-7) < 1e-15);
  assert.equal(s.blockTime, 1_790_000_000_000);
});

test('W2 sell back to SOL: tokens out, SOL in', () => {
  const tx = makeTx({
    solPre: 4e9,
    solPost: 4e9 + 1.8e9 - FEE,
    pre: [tb(2, MEME, WALLET, 2_000_000_000_000)],
    post: [tb(2, MEME, WALLET, 0)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'sell');
  assert.equal(s.tokenAmount, 2_000_000);
  assert.ok(Math.abs(s.quoteAmount - 1.8) < 1e-9);
});

test('W3 sell that closes the token account still counts the full amount', () => {
  const tx = makeTx({
    solPre: 4e9,
    solPost: 4e9 + 0.5e9 + 2_039_280 - FEE,
    pre: [tb(2, MEME, WALLET, 1_000_000_000)],
    post: [],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'sell');
  assert.equal(s.tokenAmount, 1000);
});

test('W4 Jupiter buy paid in USDC uses USDC as the quote', () => {
  const tx = makeTx({
    solPre: 5e9,
    solPost: 5e9 - FEE,
    pre: [tb(3, USDC, WALLET, 500_000_000), tb(2, MEME, WALLET, 0)],
    post: [tb(3, USDC, WALLET, 250_000_000), tb(2, MEME, WALLET, 1_000_000_000_000)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'buy');
  assert.equal(s.quoteSymbol, 'USDC');
  assert.equal(s.quoteAmount, 250);
});

test('W5 wrapped-SOL route (WSOL account pre-existing) is treated as SOL', () => {
  const tx = makeTx({
    solPre: 5e9,
    solPost: 5e9 - FEE,
    pre: [tb(3, WSOL_MINT, WALLET, 3e9, 9), tb(2, MEME, WALLET, 0)],
    post: [tb(3, WSOL_MINT, WALLET, 2e9, 9), tb(2, MEME, WALLET, 7_000_000)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'buy');
  assert.equal(s.quoteSymbol, 'SOL');
  assert.ok(Math.abs(s.quoteAmount - 1) < 1e-9);
});

test('W6 token-to-token swap, plain transfer, airdrop and failed tx are skipped', () => {
  const swap = makeTx({
    pre: [tb(2, MEME, WALLET, 1_000_000), tb(3, MEME2, WALLET, 0)],
    post: [tb(2, MEME, WALLET, 0), tb(3, MEME2, WALLET, 5_000_000)],
    solPost: 5e9 - FEE,
  });
  assert.match(parseSwapFromTransaction(swap, WALLET).skip, /token-to-token/);

  const transfer = makeTx({ solPost: 5e9 - 1e9 - FEE });
  assert.match(parseSwapFromTransaction(transfer, WALLET).skip, /no token/);

  const airdrop = makeTx({ solPost: 5e9 - FEE, post: [tb(2, MEME, WALLET, 9_000_000)] });
  assert.match(parseSwapFromTransaction(airdrop, WALLET).skip, /without paying/);

  const failed = makeTx({ err: { InstructionError: [2, { Custom: 6001 }] } });
  assert.equal(parseSwapFromTransaction(failed, WALLET).skip, 'failed transaction');
});

test('W7 wallet that did not pay the fee (relayed tx) still parses correctly', () => {
  const tx = makeTx({
    payer: 'Relayer11111111111111111111111111111111111',
    solPre: 3e9,
    solPost: 3e9 - 0.25e9,
    post: [tb(2, MEME, WALLET, 400_000_000)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'buy');
  assert.ok(Math.abs(s.quoteAmount - 0.25 - 2_039_280 / 1e9) < 1e-6 || Math.abs(s.quoteAmount - 0.25) < 0.003);
});

// ---------------------------------------------------------------------------
// Watcher with a mock RPC + DexScreener
// ---------------------------------------------------------------------------
function mockNetwork() {
  const chain = { sigs: [], txs: new Map(), rateLimitNext: 0, calls: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('dexscreener')) {
      const mint = String(url).split('/').pop();
      const pairs =
        mint === WSOL_MINT
          ? [{ chainId: 'solana', baseToken: { address: WSOL_MINT, symbol: 'SOL', name: 'Wrapped SOL' }, priceUsd: '200', liquidity: { usd: 1e8 } }]
          : [{ chainId: 'solana', dexId: 'pumpfun', url: 'https://dexscreener.com/solana/x', baseToken: { address: mint, symbol: 'MEME', name: 'Meme Coin' }, priceUsd: '0.0001', marketCap: 100000, liquidity: { usd: 25000 } }];
      return new Response(JSON.stringify({ pairs }), { status: 200 });
    }
    const body = JSON.parse(opts.body);
    chain.calls.push(body.method);
    if (chain.rateLimitNext > 0) {
      chain.rateLimitNext -= 1;
      return new Response('Too many requests', { status: 429 });
    }
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const { limit = 1000, until } = body.params[1] || {};
      let list = chain.sigs; // newest first
      if (until) {
        const i = list.findIndex((s) => s.signature === until);
        list = i >= 0 ? list.slice(0, i) : list;
      }
      result = list.slice(0, limit);
    } else if (body.method === 'getTransaction') {
      result = chain.txs.get(body.params[0]) || null;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const push = (tx) => {
    chain.sigs.unshift({ signature: tx.transaction.signatures[0], err: tx.meta.err });
    chain.txs.set(tx.transaction.signatures[0], tx);
  };
  return { chain, fetchImpl, push };
}

const buyTx = (sig) =>
  makeTx({ sig, solPre: 5e9, solPost: 5e9 - 0.5e9 - FEE, pre: [tb(2, MEME, WALLET, 0)], post: [tb(2, MEME, WALLET, 5_000_000_000_000)] });

test('W8 first poll backfills the last N swaps; later polls only emit new ones, oldest first', async () => {
  const net = mockNetwork();
  for (let i = 0; i < 5; i++) net.push(buyTx(`old${i}`));
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: net.fetchImpl, backfillCount: 3, onSignal: (s) => got.push(s) });
  w.setWallets([{ address: WALLET, label: 'whale1' }]);
  await w.pollOnce();
  assert.deepEqual(got.map((s) => s.signature), ['old2', 'old3', 'old4']);
  assert.ok(got.every((s) => s.backfill));

  net.push(buyTx('new1'));
  net.push(buyTx('new2'));
  await w.pollOnce();
  assert.deepEqual(got.slice(3).map((s) => s.signature), ['new1', 'new2']);
  assert.ok(got.slice(3).every((s) => !s.backfill));

  await w.pollOnce();
  assert.equal(got.length, 5, 'no duplicates on a quiet poll');
});

test('W9 signals are enriched with DexScreener symbol, USD value and market cap', async () => {
  const net = mockNetwork();
  net.push(buyTx('s1'));
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: net.fetchImpl, backfillCount: 1, onSignal: (s) => got.push(s), tokenInfo: new TokenInfoService({ fetchImpl: net.fetchImpl }) });
  w.setWallets([{ address: WALLET, label: 'whale1' }]);
  await w.pollOnce();
  const s = got[0];
  assert.equal(s.symbol, 'MEME');
  assert.equal(s.side, 'buy');
  assert.ok(Math.abs(s.usdValue - 100) < 1e-6, `usd ${s.usdValue}`); // 0.5 SOL × $200
  assert.equal(s.marketCapUsd, 100000);
  assert.equal(s.label, 'whale1');
  assert.equal(s.explorerUrl, 'https://solscan.io/tx/s1');
});

test('W10 rate limit (429) is reported and backs off without losing progress', async () => {
  const net = mockNetwork();
  net.push(buyTx('a1'));
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: net.fetchImpl, backfillCount: 1, pollIntervalMs: 10_000, onSignal: (s) => got.push(s) });
  w.setWallets([{ address: WALLET }]);
  // a single 429 is retried after a short pause and the trade still arrives
  net.chain.rateLimitNext = 1;
  await w.pollOnce();
  assert.equal(got.length, 1, 'one 429 is absorbed by the retry');
  assert.equal(w.getStatus().rateLimited, false);
  // a run of 429s (provider really over its limit) is reported and the watcher backs off
  net.push(buyTx('a2'));
  net.chain.rateLimitNext = 10;
  await w.pollOnce();
  assert.equal(w.getStatus().rateLimited, true);
  assert.ok(w.backoffMs >= 20_000);
  net.chain.rateLimitNext = 0;
  await w.pollOnce();
  assert.equal(got.length, 2, 'nothing lost after the back-off');
  assert.equal(w.getStatus().rateLimited, false);
  assert.equal(w.backoffMs, 0);
});

test('W11 invalid addresses are ignored and failed transactions never emit', async () => {
  const net = mockNetwork();
  net.push(makeTx({ sig: 'bad', err: { InstructionError: [0, 'x'] }, post: [tb(2, MEME, WALLET, 1)] }));
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: net.fetchImpl, backfillCount: 5, onSignal: (s) => got.push(s) });
  w.setWallets([{ address: 'not-a-wallet' }, { address: WALLET }]);
  assert.equal(w.getStatus().wallets.length, 1);
  await w.pollOnce();
  assert.equal(got.length, 0);
  assert.ok(!net.chain.calls.includes('getTransaction'), 'failed signatures are not even fetched');
});

test('W12 partial sell reports the share of the bag sold (for Mirror mode)', () => {
  const tx = makeTx({
    solPre: 5e9,
    solPost: 5e9 + 0.4e9 - FEE,
    pre: [tb(2, MEME, WALLET, 4_000_000_000_000)],
    post: [tb(2, MEME, WALLET, 3_000_000_000_000)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.side, 'sell');
  assert.equal(s.sellSharePct, 25);
});

test('W13 version 1 transactions are requested (v0-only requests made the RPC refuse them)', async () => {
  const seen = [];
  const v1tx = makeTx({ solPost: 5e9 - 0.5e9 - FEE - 2_039_280, post: [tb(2, MEME, WALLET, 1_000_000_000)] });
  v1tx.version = 1;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'getTransaction') {
      const v = body.params[1].maxSupportedTransactionVersion;
      seen.push(v);
      if (v < 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32015, message: 'Transaction version (1) is not supported by the requesting client.' } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: v1tx }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }));
  };
  const w = new SolanaWalletWatcher({ fetchImpl, tokenInfo: { get: async () => null, solPriceUsd: async () => 200 } });
  const tx = await w.getTransaction('x');
  assert.equal(tx.version, 1);
  assert.equal(seen[0], 1);
  assert.equal(parseSwapFromTransaction(tx, WALLET).side, 'buy');
});

test('W14 an RPC that rejects version 1 falls back to version 0', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const v = body.params[1].maxSupportedTransactionVersion;
    if (v === 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: makeTx() }));
  };
  const w = new SolanaWalletWatcher({ fetchImpl });
  assert.ok(await w.getTransaction('x'));
  assert.equal(w.txVersion, 0);
});

test('W15 wallet check: counts copyable swaps and explains the rest', async () => {
  const txs = {
    a: makeTx({ solPost: 5e9 - 1e9 - FEE - 2_039_280, post: [tb(2, MEME, WALLET, 1_000_000_000)] }),
    b: makeTx({ payer: 'Spammer11111111111111111111111111111111111', post: [tb(2, MEME2, WALLET, 5_000_000_000)] }),
    c: makeTx({ pre: [tb(2, USDC, WALLET, 100_000_000)], post: [tb(2, USDC, WALLET, 0)] }),
  };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'getSignaturesForAddress') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: ['a', 'b', 'c'].map((signature) => ({ signature, err: null, blockTime: 1_790_000_000 })) }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: txs[body.params[0]] }));
  };
  const w = new SolanaWalletWatcher({ fetchImpl });
  const r = await w.checkWallet(WALLET);
  assert.equal(r.verdict, 'copyable');
  assert.equal(r.checked, 3);
  assert.equal(r.buys, 1);
  assert.equal(Object.values(r.ignored).reduce((a, b) => a + b, 0), 2);
  assert.ok(r.ignored['tokens received without paying (airdrop or transfer in)']);
});

import { diffHoldings, isFlooded } from '../engine/walletWatcher.mjs';

const snap = (sol, entries) => ({ sol, tokens: new Map(entries), at: Date.now() });

test('W16 flood detection: 100 entries inside 3 minutes = flooded; a normal trader is not', () => {
  const t = 1_790_000_000;
  const busy = Array.from({ length: 100 }, (_, i) => ({ signature: `s${i}`, blockTime: t - i, err: i % 3 ? {} : null }));
  const fastTrader = Array.from({ length: 100 }, (_, i) => ({ signature: `f${i}`, blockTime: t - i * 1.2, err: null }));
  assert.equal(isFlooded(fastTrader, 100), false, 'a fast bot trading for itself (mostly successful) stays in exact mode');
  const calm = Array.from({ length: 100 }, (_, i) => ({ signature: `s${i}`, blockTime: t - i * 600 }));
  assert.equal(isFlooded(busy, 100), true);
  assert.equal(isFlooded(calm, 100), false);
  assert.equal(isFlooded(busy.slice(0, 10), 100), false);
});

test('W17 balance diff: buy (token up, SOL down), partial sell (token down, SOL up), airdrop has no payment', () => {
  const buy = diffHoldings(snap(10, [[MEME, 0]]), snap(9, [[MEME, 1000]]));
  assert.equal(buy.length, 1);
  assert.equal(buy[0].side, 'buy');
  assert.equal(buy[0].quoteSymbol, 'SOL');
  assert.ok(Math.abs(buy[0].quoteAmount - 1) < 1e-9);

  const sell = diffHoldings(snap(9, [[MEME, 1000]]), snap(9.6, [[MEME, 250]]));
  assert.equal(sell[0].side, 'sell');
  assert.equal(sell[0].sellSharePct, 75);
  assert.ok(Math.abs(sell[0].quoteAmount - 0.6) < 1e-9);

  const drop = diffHoldings(snap(9, []), snap(9, [[MEME2, 5000]]));
  assert.equal(drop[0].side, 'buy');
  assert.equal(drop[0].quoteSymbol, undefined, 'no SOL/USDC left the wallet → airdrop');

  const usdc = diffHoldings(snap(1, [[USDC, 100]]), snap(1, [[USDC, 40], [MEME, 10]]));
  assert.equal(usdc[0].quoteSymbol, 'USDC');
  assert.equal(usdc[0].quoteAmount, 60);
});

test('W18 flooded wallet: balance changes are verified against the real transaction; fakes are dropped', async () => {
  const t = Math.floor(Date.now() / 1000);
  let holdings = { sol: 10e9, tokens: [] };
  const accTx = new Map(); // token account → [{signature, tx}]
  const txs = new Map();
  const realSwap = (sig, mint, pre, post, solPre, solPost) => {
    const tx = makeTx({ sig, solPre, solPost, pre: pre ? [tb(2, mint, WALLET, pre)] : [], post: post ? [tb(2, mint, WALLET, post)] : [], blockTime: t });
    txs.set(sig, tx);
    accTx.set(`acc-${mint}`, [{ signature: sig, err: null, blockTime: t }, ...(accTx.get(`acc-${mint}`) || [])]);
  };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') {
      const addr = body.params[0];
      // the wallet's own signature list: its real trades (newest first) buried in failed spam
      const own = [...txs.keys()].reverse().map((signature) => ({ signature, err: null, blockTime: t }));
      result = addr.startsWith('acc-') ? accTx.get(addr) || [] : [...own, ...Array.from({ length: body.params[1].limit }, (_, i) => ({ signature: `spam${i}-${Math.random()}`, err: { InstructionError: [1, { Custom: 3 }] }, blockTime: t - (i % 50) }))].slice(0, body.params[1].limit);
    } else if (body.method === 'getBalance') result = { value: holdings.sol };
    else if (body.method === 'getTokenAccountsByOwner') {
      result = { value: body.params[1].programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? holdings.tokens.map(([mint, amount]) => ({ pubkey: `acc-${mint}`, account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals: 6 } } } } } })) : [] };
    } else if (body.method === 'getTransaction') result = txs.get(body.params[0]) || null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl, tokenInfo: { get: async () => ({ symbol: 'MEME', priceUsd: 0.0002 }), solPriceUsd: async () => 200 }, onSignal: (s) => got.push(s) });
  w.setWallets([{ address: WALLET, label: 'busy' }]);
  await w.pollOnce(); // detects flood, takes baseline
  assert.equal(w.wallets.get(WALLET).mode, 'balances');
  // real buy: 1M MEME for 1 SOL (its own transaction exists on the token account)
  realSwap('realbuy', MEME, 0, 1_000_000_000_000, 10e9, 9e9 - FEE - 2_039_280);
  holdings = { sol: 9e9, tokens: [[MEME, 1_000_000_000_000]] };
  await w.pollOnce();
  // FAKE: MEME2 appears and SOL drops at the same time, but there is no swap transaction
  holdings = { sol: 8.5e9, tokens: [[MEME, 1_000_000_000_000], [MEME2, 5_000_000_000]] };
  await w.pollOnce();
  // real sell of half
  realSwap('realsell', MEME, 1_000_000_000_000, 500_000_000_000, 8.5e9, 9e9 - FEE);
  holdings = { sol: 9e9, tokens: [[MEME, 500_000_000_000], [MEME2, 5_000_000_000]] };
  await w.pollOnce();
  assert.deepEqual(got.map((s) => [s.side, s.signature]), [['buy', 'realbuy'], ['sell', 'realsell']]);
  assert.ok(Math.abs(got[0].quoteAmount - 1) < 0.01, `exact fill from the real tx: ${got[0].quoteAmount}`);
  assert.equal(got[1].sellSharePct, 50);
  assert.equal(got[0].source, 'balances-verified');
  // the FAKE (SOL drop + junk token, no transaction signed by the wallet) never became a signal
  assert.ok(!got.some((s) => s.tokenMint === MEME2), 'fake change dropped');
});

test('W19 balance mode: closing spam token accounts (rent refund) is not a sale; dust is ignored', async () => {
  let holdings = { sol: 10e9, tokens: [['SpamA1111111111111111111111111111111111111', 5e9], ['SpamB1111111111111111111111111111111111111', 7e9]] };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getSignaturesForAddress') result = Array.from({ length: 100 }, (_, i) => ({ signature: `s${i}${Math.random()}`, err: {}, blockTime: 1_790_000_000 }));
    else if (body.method === 'getBalance') result = { value: holdings.sol };
    else if (body.method === 'getTokenAccountsByOwner') result = { value: body.params[1].programId.startsWith('Tokenkeg') ? holdings.tokens.map(([mint, amount]) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals: 6 } } } } } })) : [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl, tokenInfo: { get: async () => ({ priceUsd: 0.000002 }), solPriceUsd: async () => 200 }, onSignal: (s) => got.push(s) });
  w.setWallets([{ address: WALLET }]);
  await w.pollOnce();
  // both spam accounts are closed: tokens gone, ~0.004 SOL rent refunded
  holdings = { sol: 10e9 + 2 * 2_039_280, tokens: [] };
  await w.pollOnce();
  assert.equal(got.length, 0, 'no fake sells from rent refunds');
});

test('W20 one slow wallet does not stop other wallets from being read', async () => {
  const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const polled = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.params?.[0] === WALLET) await new Promise((r) => setTimeout(r, 400)); // slow wallet
    if (body.method === 'getSignaturesForAddress') polled.push(body.params[0]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }));
  };
  const w = new SolanaWalletWatcher({ fetchImpl, walletBudgetMs: 150 });
  w.setWallets([{ address: WALLET }, { address: OTHER }]);
  const t0 = Date.now();
  await w.pollOnce();
  assert.ok(polled.includes(OTHER), 'other wallet was read');
  assert.ok(Date.now() - t0 < 350, 'round finished within the time budget');
  // slow is not broken: no error, just marked slow until the check finishes
  assert.equal(w.wallets.get(WALLET).error, null);
  assert.ok(w.getStatus().wallets.find((x) => x.address === WALLET).slowSince > 0, 'marked as slow');
  assert.equal(w.getStatus().lastError, null);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(w.wallets.get(WALLET).slowSince, null, 'cleared once the slow check finished');
  assert.equal(w.wallets.get(WALLET).busy, false);
});

test('W21 dust nudge on another held token does not hide a real buy (Decu-style FLASHX trade)', () => {
  const DUST = 'PreweJ11111111111111111111111111111111111111';
  const tx = makeTx({
    solPre: 417e9,
    solPost: 417e9 - 0.04e9 - FEE,
    pre: [tb(2, MEME, WALLET, 16_278_752_473_851), tb(3, DUST, WALLET, 15_238_703, 9)],
    post: [tb(2, MEME, WALLET, 16_322_661_226_135), tb(3, DUST, WALLET, 15_238_753, 9)],
  });
  const s = parseSwapFromTransaction(tx, WALLET);
  assert.equal(s.skip, undefined, `not skipped (${s.skip})`);
  assert.equal(s.side, 'buy');
  assert.equal(s.tokenMint, MEME);
  assert.ok(Math.abs(s.tokenAmount - 43_908.752284) < 0.01);
  assert.ok(Math.abs(s.quoteAmount - 0.04) < 1e-6);
  // two real token moves are still refused
  const t2 = makeTx({ pre: [tb(2, MEME, WALLET, 1e12), tb(3, MEME2, WALLET, 0)], post: [tb(2, MEME, WALLET, 0), tb(3, MEME2, WALLET, 5e12)] });
  assert.match(parseSwapFromTransaction(t2, WALLET).skip, /token-to-token/);
});

// ---------- copy-bot bait: dust of a second token in every buy (Decu, 30 Oct) ----------
import { dropDustMoves, diffHoldings as diffHoldingsDust } from '../engine/walletWatcher.mjs';

test('dust bait: a buy that also receives +0.04 of another token is still read as a buy of the real coin', () => {
  const W = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
  const COIN = 'B1indApe1111111111111111111111111111111pump';
  const DUST = 'NeuraL1nk11111111111111111111111111111pump';
  const tb = (mint, amount) => ({ accountIndex: mint === COIN ? 2 : 3, mint, owner: W, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const tx = {
    slot: 1, blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, fee: 5000, preBalances: [435.041048395e9, 0, 0, 0, 1], postBalances: [431.60359821e9, 0, 0, 0, 1], preTokenBalances: [], postTokenBalances: [tb(COIN, 30751441657619), tb(DUST, 44534)] },
    transaction: { signatures: ['x'], message: { accountKeys: [{ pubkey: W }, { pubkey: 'Pool111111111111111111111111111111111111111' }, { pubkey: 'Acc1111111111111111111111111111111111111111' }, { pubkey: 'Acc2111111111111111111111111111111111111111' }, { pubkey: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }] } },
  };
  const s = parseSwapFromTransaction(tx, W);
  assert.equal(s.skip, undefined, s.skip);
  assert.equal(s.side, 'buy');
  assert.equal(s.tokenMint, COIN);
  assert.ok(Math.abs(s.tokenAmount - 30751441.657619) < 1e-3);
  assert.equal(s.quoteSymbol, 'SOL');
  // two real coins in one transaction is still unclear and skipped
  const two = JSON.parse(JSON.stringify(tx));
  two.meta.postTokenBalances[1].uiTokenAmount.amount = String(5_000_000 * 1e6);
  assert.equal(parseSwapFromTransaction(two, W).skip, 'multiple tokens moved');
});

test('dust bait: balance-watch mode (flooded wallets) also ignores the dust token', () => {
  const kept = dropDustMoves([{ side: 'buy', tokenAmount: 30_751_441 }, { side: 'buy', tokenAmount: 0.0445 }], (m) => (m.side === 'buy' ? m.tokenAmount : -m.tokenAmount));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tokenAmount, 30_751_441);
  // a small real sell next to a big buy is not "dust" of the same direction
  assert.equal(dropDustMoves([{ d: 50_000 }, { d: -0.5 }], (m) => m.d).length, 2);
});

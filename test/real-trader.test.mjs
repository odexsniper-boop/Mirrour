// Real trading engine: signing, Jupiter flow, limits, exact fills and failure handling.
// Runs offline against a mock Jupiter API + mock Solana RPC (nothing is sent anywhere).
// Run: node --test test/real-trader.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RealTrader, loadKeypair, signTransactionBase64, WSOL_MINT } from '../engine/realTrader.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';

const MINT = 'MemeMint1111111111111111111111111111111pump';
const SOL_PX = 200;
CHAINS.solana.nativePriceUsd = SOL_PX;

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), pub: Buffer.from(pub) };
}

/** Minimal v0 transaction: 1 signer slot, payer = bot wallet */
function fakeTx(payer, extraSigners = 0) {
  const n = 1 + extraSigners;
  const keys = [payer, ...Array.from({ length: extraSigners }, () => crypto.randomBytes(32)), crypto.randomBytes(32)];
  const msg = Buffer.concat([Buffer.from([0x80, n, 0, 1, keys.length]), ...keys, crypto.randomBytes(32), Buffer.from([0, 0])]);
  return Buffer.concat([Buffer.from([n]), Buffer.alloc(64 * n), msg]).toString('base64');
}

function verifySigned(b64, pub, slot = 0) {
  const tx = Buffer.from(b64, 'base64');
  const n = tx[0];
  const msg = tx.subarray(1 + 64 * n);
  const sig = tx.subarray(1 + 64 * slot, 1 + 64 * slot + 64);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  return crypto.verify(null, msg, key, sig);
}

/**
 * Mock world: wallet balances, Jupiter /order + /execute, RPC.
 * tokenPriceUsd = price the route fills at; executeMode: 'ok' | 'fail' | 'timeout-landed' | 'timeout-lost'
 */
function world({ sol = 5, tokenPriceUsd = 0.00002, decimals = 6, executeMode = 'ok', feeLamports = 2_105_000 } = {}) {
  const k = newKey();
  const w = { sol: BigInt(Math.round(sol * 1e9)), tok: 0n, sent: [], executeMode, txs: new Map(), orders: 0 };
  const lastOrder = {};
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const reply = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
    if (u.pathname.endsWith('/order')) {
      w.orders++;
      const amount = BigInt(u.searchParams.get('amount'));
      const input = u.searchParams.get('inputMint');
      Object.assign(lastOrder, { input, amount, slippageBps: u.searchParams.get('slippageBps') });
      let out;
      if (input === WSOL_MINT) out = BigInt(Math.floor(((Number(amount) / 1e9) * SOL_PX * 0.99) / tokenPriceUsd * 10 ** decimals));
      else out = BigInt(Math.floor(((Number(amount) / 10 ** decimals) * tokenPriceUsd * 0.99) / SOL_PX * 1e9));
      return reply({ transaction: fakeTx(k.pub), requestId: `req-${w.orders}`, outAmount: out.toString(), inAmount: amount.toString(), router: 'metis' });
    }
    if (u.pathname.endsWith('/execute')) {
      const body = JSON.parse(opts.body);
      w.sent.push(body);
      assert.ok(verifySigned(body.signedTransaction, k.pub), 'execute received a validly signed transaction');
      const sigB = Buffer.from(body.signedTransaction, 'base64').subarray(1, 65);
      const signature = base58Encode(sigB);
      const { input, amount } = lastOrder;
      let outAmt;
      if (input === WSOL_MINT) outAmt = BigInt(Math.floor(((Number(amount) / 1e9) * SOL_PX * 0.99) / tokenPriceUsd * 10 ** decimals));
      else outAmt = BigInt(Math.floor(((Number(amount) / 10 ** decimals) * tokenPriceUsd * 0.99) / SOL_PX * 1e9));
      const land = () => {
        const pre = { sol: w.sol, tok: w.tok };
        if (input === WSOL_MINT) {
          w.sol -= amount + BigInt(feeLamports);
          w.tok += outAmt;
        } else {
          w.tok -= amount;
          w.sol += outAmt - 5000n;
        }
        w.txs.set(signature, { pre, post: { sol: w.sol, tok: w.tok }, fee: input === WSOL_MINT ? feeLamports : 5000 });
      };
      if (w.executeMode === 'fail') return reply({ status: 'Failed', code: -1000, error: 'Failed to land', signature });
      if (w.executeMode === 'fail-but-landed') {
        land(); // our own direct copy of the swap landed although Jupiter gave up
        return reply({ status: 'Failed', code: -1000, error: 'Failed to land', signature });
      }
      if (w.executeMode === 'timeout-landed') {
        land();
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (w.executeMode === 'timeout-lost') {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      land();
      return reply({ status: 'Success', code: 0, signature, totalInputAmount: amount.toString(), inputAmountResult: amount.toString(), outputAmountResult: outAmt.toString(), totalOutputAmount: outAmt.toString() });
    }
    return reply({ error: 'not found' }, 404);
  };
  const owner = () => loadKeypair(k.secret).publicKey;
  const tokBal = (mint, raw) => ({ owner: owner(), mint, uiTokenAmount: { amount: raw.toString(), decimals } });
  const rpc = async (method, params) => {
    if (method === 'getBalance') return { value: Number(w.sol) };
    if (method === 'getTokenSupply') return { value: { decimals } };
    if (method === 'getTokenAccountsByOwner') {
      const mint = params[1].mint;
      if (mint === MINT && w.tok > 0n) return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: w.tok.toString(), decimals } } } } } }] };
      return { value: [] };
    }
    if (method === 'getSignatureStatuses') {
      const t = w.txs.get(params[0][0]);
      return { value: [t ? { confirmationStatus: 'confirmed', err: null } : null] };
    }
    if (method === 'getTransaction') {
      if (w.hideTx) return null; // RPC hasn't indexed it yet (fast path)
      const t = w.txs.get(params[0]);
      if (!t) return null;
      return {
        meta: {
          fee: t.fee,
          preBalances: [Number(t.pre.sol)],
          postBalances: [Number(t.post.sol)],
          preTokenBalances: t.pre.tok > 0n ? [tokBal(MINT, t.pre.tok)] : [],
          postTokenBalances: t.post.tok > 0n ? [tokBal(MINT, t.post.tok)] : [],
        },
        transaction: { message: { accountKeys: [{ pubkey: owner() }] } },
      };
    }
    if (method === 'simulateTransaction') return { value: { err: null, logs: [] } };
    throw new Error(`unexpected rpc ${method}`);
  };
  let t = 1_800_000_000_000;
  const trader = new RealTrader({ env: { ODEX_TRADER_KEY: k.secret }, rpc, solPrice: () => SOL_PX, fetchImpl, sleep: async () => { t += 1500; }, now: () => t });
  return { w, k, trader, rpc, fetchImpl, lastOrder, tick: (ms) => (t += ms) };
}

function engineFor(trader, { paper = false, mode = 'auto-exit', size = 50 } = {}) {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = paper;
  e.settings.cooldown.enabled = false;
  e.settings.tradingAsset.solana = 'native';
  e.settings.copyTopUps = true; // these tests buy the same coin repeatedly
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => trader.ready();
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-real', walletId: e.getActiveWallet().id, name: 't', handle: 't', traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ', chainId: 'solana',
    status: 'copying', pauseReason: null, mode, sizing: { type: 'fixed', amount: size }, tpPct: null, slPct: null, minTradeUsd: 1,
    maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);
  return { e, f };
}
const buySig = (f, px = 0.00002) => ({
  chainId: 'solana', side: 'buy', traderHandle: 't', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: crypto.randomBytes(8).toString('hex'),
  token: { address: MINT, symbol: 'MEME', name: 'Meme', isLaunchpad: true, stage: 'pre-grad', marketCapUsd: 20000, traderFillPriceUsd: px, currentPriceUsd: px, safety: { safetyVerified: true } },
});

test('key loading: Phantom 64-byte base58 export, seed-only, JSON array; damaged key rejected', () => {
  const k = newKey();
  const kp = loadKeypair(k.secret);
  assert.equal(kp.publicKey, base58Encode(k.pub));
  const msg = Buffer.from('hello');
  assert.ok(kp.verify(msg, kp.sign(msg)));
  assert.throws(() => loadKeypair(base58Encode(Buffer.concat([crypto.randomBytes(32), k.pub]))), /damaged/);
  assert.throws(() => loadKeypair('abc'), /bytes/);
});

test('signing puts a valid Ed25519 signature in the bot wallet slot only', () => {
  const k = newKey();
  const kp = loadKeypair(k.secret);
  const s = signTransactionBase64(fakeTx(k.pub), kp);
  assert.ok(verifySigned(s.signedBase64, k.pub));
  assert.throws(() => signTransactionBase64(fakeTx(crypto.randomBytes(32)), kp), /not for the bot wallet/);
});

test('real copy buy: exact tokens and cost from the chain, isPaper=false, tx hash recorded', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader);
  const solBefore = w.sol;
  const [r] = await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  assert.ok(p, `position opened (${JSON.stringify(r)})`);
  assert.equal(p.isPaper, false);
  assert.equal(w.sent.length, 1);
  assert.equal(p.remainingTokens, Number(w.tok) / 1e6, 'tokens = what reached the wallet');
  const spentSol = Number(solBefore - w.sol) / 1e9;
  assert.ok(Math.abs(p.initialCostUsd - spentSol * SOL_PX) < 0.01, `cost ${p.initialCostUsd} = SOL really spent ${spentSol * SOL_PX}`);
  assert.match(e.history[0].txHash, /^[1-9A-HJ-NP-Za-km-z]{60,90}$/);
  assert.ok(e.history[0].explorerUrl.startsWith('https://solscan.io/tx/'));
});

test('real sell of the whole position sells the full wallet balance and books exact SOL received', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  const solBefore = w.sol;
  const r = await e.executePositionSell(p.id, { sellPct: 100 });
  assert.notEqual(r?.ok, false, JSON.stringify(r));
  assert.equal(w.tok, 0n, 'wallet holds no tokens after a 100% sell');
  assert.equal(p.remainingTokens, 0);
  const gotUsd = (Number(w.sol - solBefore) / 1e9) * SOL_PX;
  assert.ok(Math.abs(p.soldUsd - gotUsd) < 0.01, `booked ${p.soldUsd} = received ${gotUsd}`);
  assert.ok(Math.abs(p.realizedPnlUsd - (p.soldUsd - p.initialCostUsd)) < 0.01);
  assert.equal(e.history[0].isPaper, false);
});

test('per-trade cap: a 0.6 SOL buy is refused; nothing sent, no position', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { size: 0.6 * SOL_PX });
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 0);
  assert.equal(w.sent.length, 0);
  assert.match(e.history[0].reason, /per-trade limit/);
});

test('24 h cap: 2 SOL per day stops the 5th 0.45 SOL buy; resets after 24 h', async () => {
  const { w, trader, tick } = world({ sol: 10 });
  const { e, f } = engineFor(trader, { size: 0.45 * SOL_PX, mode: 'buy-hold' });
  for (let i = 0; i < 5; i++) await e.processTraderSignal(buySig(f));
  assert.equal(w.sent.length, 4);
  assert.match(e.history[0].reason, /daily limit/);
  tick(86_400_001);
  await e.processTraderSignal(buySig(f));
  assert.equal(w.sent.length, 5);
});

test('SOL reserve: never spends the SOL kept for fees', async () => {
  const { w, trader } = world({ sol: 0.26 });
  const { e, f } = engineFor(trader, { size: 0.25 * SOL_PX });
  await e.processTraderSignal(buySig(f));
  assert.equal(w.sent.length, 0);
  assert.match(e.history[0].reason, /not enough SOL/);
});

test('failed swap: no position, alert raised, daily cap not used up', async () => {
  const { trader } = world({ executeMode: 'fail' });
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 0);
  assert.match(e.history[0].reason, /real buy failed/);
  assert.equal(e.alerts[0].level, 'danger');
  assert.equal(trader.spent24hSol(), 0);
});

test('lost response but the swap landed: found on-chain and booked once', async () => {
  const { w, trader } = world({ executeMode: 'timeout-landed' });
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 1);
  assert.equal(e.positions[0].remainingTokens, Number(w.tok) / 1e6);
});

test('lost response and not on-chain: no position, "result unknown" alert', async () => {
  const { trader } = world({ executeMode: 'timeout-lost' });
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 0);
  assert.match(e.alerts[0].title, /unknown/);
});

test('paper positions still settle on paper while real trading is on', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { paper: true, mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  assert.equal(p.isPaper, true);
  e.settings.paperTrading = false; // switch to real
  const paperBefore = e.getActiveWallet().paperBalanceUsd;
  await e.executePositionSell(p.id, { sellPct: 100 });
  assert.equal(w.sent.length, 0, 'no real transaction for a paper position');
  assert.ok(e.getActiveWallet().paperBalanceUsd > paperBefore, 'proceeds back to the paper balance');
});

test('Paper OFF without a key: nothing is copied (no fake real trades)', async () => {
  const { e, f } = engineFor({ hooks: () => ({}), ready: () => false });
  e.adapter.realEnabled = () => false;
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 0);
  assert.match(e.history[0].reason, /real trading is off — the bot wallet key ODEX_TRADER_KEY is missing/);
});

test('one real sell per position at a time; a failed exit is retried (initials flag restored)', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  // two exits at once: only one transaction
  const [a, b] = await Promise.all([e.executePositionSell(p.id, { sellPct: 50 }), e.executePositionSell(p.id, { sellPct: 50 })]);
  assert.equal(w.sent.length, 2, 'buy + one sell');
  assert.ok(a.inFlight || b.inFlight);
  // failed exit: take-initials mark is undone so it fires again later
  w.executeMode = 'fail';
  p.currentPriceUsd = p.entryPriceUsd * 3;
  p.peakPriceUsd = p.currentPriceUsd;
  p.initialsTaken = false;
  f.exitRules.takeInitials = { enabled: true, takeAtPct: 25, sellSizePct: 50 };
  const r = await e.evaluatePositionExits(p, Date.now());
  assert.equal(r.ok, false);
  assert.equal(p.initialsTaken, false);
});

test('safe self-test signs and simulates without sending', async () => {
  const { w, trader } = world();
  const r = await trader.selfTest();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.sent.length, 0);
});

// ---------- audit regressions ----------

test('audit: a tiny partial sell never sells the whole wallet balance', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  await e.processTraderSignal(buySig(f)); // second position shares the wallet balance
  const before = w.tok;
  await assert.rejects(trader.sellAmountRaw(MINT, 1e-9, 6), /too small/);
  assert.equal(w.tok, before);
});

test('audit: real sells let Jupiter pick slippage and are not blocked by a stale market price', async () => {
  const { w, trader, lastOrder } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  p.currentPriceUsd = p.entryPriceUsd * 3; // our price is stale-high: the coin really crashed
  const r = await e.executePositionSell(p.id, { sellPct: 100 });
  assert.notEqual(r?.ok, false, JSON.stringify(r));
  assert.equal(p.remainingTokens, 0, 'stop-loss style exit went through');
  assert.equal(lastOrder.slippageBps, null, 'no fixed 1% slippage sent to Jupiter');
  assert.equal(w.tok, 0n);
});

test('audit: after a failed sell, retries wait (no Jupiter quote spam every tick)', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  w.executeMode = 'fail';
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  const orders = w.orders;
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  assert.equal(w.orders, orders, 'no new Jupiter orders during the back-off (automatic exits)');
  // a sell you press yourself tries again straight away
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'manual sell' });
  assert.ok(w.orders > orders, 'manual sell skips the back-off');
});

test('audit: tokens moved out of the bot wallet pause exits after 3 checks (one alert)', async () => {
  const { w, trader, tick } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  w.tok = 0n; // user sold in Phantom
  for (let i = 0; i < 4; i++) {
    await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' }); // automatic exits
    tick(20_000);
  }
  assert.equal(p.realTokensMissing, true);
  assert.equal(e.alerts.filter((a) => /no longer in the bot wallet/.test(a.title)).length, 1);
  assert.equal(await e.evaluatePositionExits(p), null);
});

test('audit: a landed swap whose transaction cannot be read is still booked (estimated), never lost', async () => {
  const { trader, rpc } = world();
  const brokenRpc = async (m, p) => (m === 'getTransaction' ? null : rpc(m, p));
  trader.rpc = brokenRpc;
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 1, 'position exists for the tokens that were bought (Jupiter amounts)');
  // and if even reading the amounts fails, it is booked from the quote, marked estimated
  const w2 = world();
  w2.trader.readFill = async () => {
    throw new Error('rpc down');
  };
  const { e: e2, f: f2 } = engineFor(w2.trader);
  await e2.processTraderSignal(buySig(f2));
  assert.equal(e2.positions.length, 1);
  assert.equal(w2.trader.trades[0].estimated, true);
});

// ---------- audit 2 (Oct 23): concurrency and risk-limit fixes ----------

test('audit2: two buy signals for the same coin at once are copied once (no double real buy)', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader);
  e.settings.copyTopUps = false;
  const [a, b] = await Promise.all([e.processTraderSignal(buySig(f)), e.processTraderSignal(buySig(f))]);
  assert.equal(e.positions.filter((p) => p.remainingTokens > 0).length, 1, `one position (${JSON.stringify([a, b].flat().map((r) => r.status + ':' + (r.reason || '')))})`);
  assert.equal(w.sent.length, 1, 'only one swap sent');
});

test('audit2: buys running at the same time cannot go over the daily SOL cap together', async () => {
  const { w, trader } = world({ sol: 10 });
  const token = { address: MINT, symbol: 'MEME', currentPriceUsd: 0.00002 };
  const rs = await Promise.all(Array.from({ length: 5 }, () => trader.execute({ side: 'buy', token, amountUsd: 90, slippagePct: 15, assetMode: 'native' })));
  const ok = rs.filter((r) => r.ok).length;
  assert.equal(ok, 4, `4 × 0.45 SOL fit in 2 SOL, the 5th must be refused (${rs.map((r) => r.ok || r.error).join(' | ')})`);
  assert.equal(w.sent.length, 4);
  assert.ok(trader.spent24hSol() <= 2 + 1e-9);
  assert.equal(trader.pendingBuySol, 0, 'nothing left counted as in progress');
});

test('audit2: an exit blocked by a sell already in progress does not mark "initials taken"', async () => {
  const { trader } = world();
  const { e, f } = engineFor(trader, { paper: true });
  f.exitRules.takeInitials.enabled = true;
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  p.currentPriceUsd = p.entryPriceUsd * 1.5;
  e.sellsInFlight = new Set([p.id]);
  const r = await e.evaluatePositionExits(p);
  assert.equal(r?.inFlight, true);
  assert.equal(p.initialsTaken, false, 'rule retried on the next tick');
});

test('audit2: daily loss limit is a rolling 24 h window and counts only the same mode', async () => {
  const { trader } = world();
  const { e, f } = engineFor(trader, { paper: true });
  e.settings.risk.dailyLossLimitUsd = 10;
  // a real-money loss must not pause paper buying
  e.realizedLog.push({ t: Date.now(), pnl: -50, paper: false, closes: true, posPnl: -50 });
  e.settings.risk.dailyLossTriggered = true;
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 1, 'pause lifted: no paper losses in the last 24 h');
  assert.equal(e.settings.risk.dailyLossTriggered, false);
});

// ---------- final check (Oct 24) ----------

test('final: a trade size above the SOL cap is bought AT the cap (not refused every time)', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { size: 50 }); // $50 = 0.25 SOL at $200
  trader.caps.maxSolPerTrade = 0.05;
  e.adapter.realBuyRoomUsd = () => trader.buyRoomUsd();
  const [r] = await e.processTraderSignal(buySig(f));
  assert.equal(r.status, 'filled', JSON.stringify(r));
  assert.equal(w.sent.length, 1);
  const spentSol = trader.spent24hSol();
  assert.ok(spentSol <= 0.05 + 1e-9 && spentSol > 0.04, `bought at the cap (${spentSol} SOL)`);
});

test('final: once the daily SOL cap is used up, buys are skipped before any quote is requested', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { size: 50 });
  trader.caps.maxSolPerDay = 0.3;
  e.adapter.realBuyRoomUsd = () => trader.buyRoomUsd();
  await e.processTraderSignal(buySig(f)); // 0.25 SOL
  const ordersBefore = w.orders;
  await e.processTraderSignal(buySig(f)); // only 0.05 SOL left → bought at 0.05
  await e.processTraderSignal(buySig(f)); // nothing left
  assert.ok(trader.spent24hSol() <= 0.3 + 1e-9, `never over the daily cap (${trader.spent24hSol()})`);
  assert.match(e.history[0].reason || '', /limit reached/);
  assert.equal(w.orders, ordersBefore + 1, 'no quote for the refused buy');
});

test('final: a real position is never "sold" on paper when real trading becomes unavailable', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  f.exitRules = createDefaultExitRules({ hardTimeCap: { enabled: true, timeCapSec: 10 } });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  const tokensBefore = p.remainingTokens;
  e.adapter.realEnabled = () => false; // e.g. another copy of the bot is running
  const r = await e.executePositionSell(p.id, { sellPct: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.realUnavailable, true);
  assert.equal(p.remainingTokens, tokensBefore, 'position untouched');
  assert.equal(w.sent.length, 1, 'only the buy was ever sent');
  assert.ok(!e.history.some((h) => h.side === 'sell' && h.status === 'filled'), 'no fake sell booked');
  assert.ok(e.alerts.some((a) => /real trading is off/.test(a.title)));
  // back on: the exit goes through for real
  e.adapter.realEnabled = () => trader.ready();
  const r2 = await e.executePositionSell(p.id, { sellPct: 100 });
  assert.notEqual(r2.ok, false, JSON.stringify(r2));
  assert.equal(w.sent.length, 2);
});

test('sell fix: Token-2022 tokens missed by the mint lookup are still found and sold; a manual sell clears "tokens missing"', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  // simulate an RPC that returns nothing for the mint-filtered lookup (Token-2022 coin)
  const realRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    if (method === 'getTokenAccountsByOwner' && params[1]?.mint) return { value: [] };
    if (method === 'getTokenAccountsByOwner' && params[1]?.programId) {
      if (params[1].programId !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' || w.tok <= 0n) return { value: [] };
      return { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: w.tok.toString(), decimals: 6 } } } } } }] };
    }
    return realRpc(method, params);
  };
  // the position had been flagged as "tokens missing" by earlier failed checks
  p.realTokensMissing = true;
  p.realMissingChecks = 10;
  const r = await e.executePositionSell(p.id, { sellPct: 100, cause: 'manual sell' });
  assert.notEqual(r.ok, false, JSON.stringify(r));
  assert.equal(p.remainingTokens, 0, 'sold');
  assert.equal(w.tok, 0n, 'wallet emptied of the token');
});

test('ghost fix: a real sell found in the swap log but never booked closes the position with the exact proceeds', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  const cost = p.remainingCostUsd;
  // the previous copy of the bot sold it during a redeploy; this copy never recorded it
  const sold = await trader.execute({ side: 'sell', token: { address: MINT, symbol: 'MEME', currentPriceUsd: 0.00002 }, amountUsd: 40, slippagePct: null, tokenAmount: 'all', assetMode: 'native' });
  assert.equal(sold.ok, true);
  assert.equal(w.tok, 0n);
  // nothing happens while the tokens are not yet confirmed gone
  assert.deepEqual(e.reconcileRealTrades(trader.trades), []);
  p.realTokensMissing = true;
  const booked = e.reconcileRealTrades(trader.trades);
  assert.deepEqual(booked, [p.id]);
  assert.equal(p.remainingTokens, 0);
  const rec = e.history[0];
  assert.equal(rec.side, 'sell');
  assert.equal(rec.txHash, trader.trades[0].signature);
  const expectedNet = trader.trades[0].usd - trader.trades[0].networkFeeUsd;
  assert.ok(Math.abs(rec.amountUsd - expectedNet) < 0.01, `proceeds ${rec.amountUsd} vs ${expectedNet}`);
  assert.ok(Math.abs(rec.pnlUsd - (expectedNet - cost)) < 0.02);
  assert.equal(e.realizedLog.at(-1).closes, true);
  // running it again books nothing twice
  assert.deepEqual(e.reconcileRealTrades(trader.trades), []);
});

// ---------- Fast scalp + full closes (Oct 25) ----------
import { fastScalpExitRules } from '../engine/copyEngine.mjs';

test('fast scalp: +12% take profit sells the WHOLE position (nothing left behind)', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'auto-exit' });
  f.exitRules = fastScalpExitRules();
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  p.currentPriceUsd = p.entryPriceUsd * 1.15;
  const r = await e.evaluatePositionExits(p);
  assert.notEqual(r?.ok, false, JSON.stringify(r));
  assert.equal(p.remainingTokens, 0, 'fully closed');
  assert.equal(w.tok, 0n, 'no tokens left in the wallet');
});

test('fast scalp: the −25% floor closes everything; a partial sell never leaves dust under $2', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'auto-exit' });
  f.exitRules = fastScalpExitRules();
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  p.currentPriceUsd = p.entryPriceUsd * 0.7;
  await e.evaluatePositionExits(p);
  assert.equal(p.remainingTokens, 0);
  assert.equal(w.tok, 0n);
  // dust rule: a 95% sell of a ~$10 position would leave ~$0.50 → sells 100%
  const b = engineFor(world().trader, { mode: 'buy-hold', size: 10 });
  await b.e.processTraderSignal(buySig(b.f));
  const q = b.e.positions[0];
  await b.e.executePositionSell(q.id, { sellPct: 95, cause: 'manual sell' });
  assert.equal(q.remainingTokens, 0, 'no dust left');
});

test('time cap closes the moonbag too (no position held forever after initials)', async () => {
  const { trader } = world();
  const { e, f } = engineFor(trader, { mode: 'auto-exit' });
  f.exitRules = createDefaultExitRules({ takeInitials: { enabled: true, takeAtPct: 10, sellSizePct: 50 }, hardTimeCap: { enabled: true, timeCapSec: 60 } });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  p.currentPriceUsd = p.entryPriceUsd * 1.2;
  await e.evaluatePositionExits(p); // initials: 50% sold
  assert.ok(p.remainingTokens > 0 && p.initialsTaken);
  p.currentPriceUsd = p.entryPriceUsd * 1.0;
  await e.evaluatePositionExits(p, p.openedAt + 61_000); // time cap: the rest
  assert.equal(p.remainingTokens, 0);
});

test('a failing real exit retries with more slippage room (auto → 25% → 50%)', async () => {
  const { w, trader, lastOrder } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  w.executeMode = 'fail';
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  assert.equal(p.realSellFails, 1);
  trader.sellBlockedUntil.clear();
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  assert.equal(lastOrder.slippageBps, '2500', 'second try: 25%');
  trader.sellBlockedUntil.clear();
  w.executeMode = 'ok';
  await e.executePositionSell(p.id, { sellPct: 100, cause: 'stop-loss hit' });
  assert.equal(lastOrder.slippageBps, '5000', 'third try: 50%');
  assert.equal(p.remainingTokens, 0, 'got out');
  assert.equal(p.realSellFails, 0);
});

test('speed: the balance is read while Jupiter quotes (no extra wait before sending); one quote per copy; timings recorded', { timeout: 5000 }, async () => {
  const { w, trader } = world({ sol: 5 });
  const { e, f } = engineFor(trader);
  const log = [];
  const rpc = trader.rpc;
  trader.rpc = async (m, p) => {
    if (m === 'getBalance') log.push('balance-start');
    const r = await rpc(m, p);
    if (m === 'getBalance') log.push('balance-done');
    return r;
  };
  const fetch0 = trader.fetch;
  trader.fetch = async (url, opts) => {
    const path = new URL(url).pathname.split('/').pop();
    log.push(`${path}-start`);
    const r = await fetch0(url, opts);
    log.push(`${path}-done`);
    return r;
  };
  const ordersBefore = w.orders;
  await e.processTraderSignal(buySig(f));
  assert.ok(e.positions[0], 'bought');
  assert.equal(w.orders - ordersBefore, 1, 'exactly one Jupiter quote');
  // the balance read starts before the quote finishes, and no new balance read starts between
  // the quote and the send
  assert.ok(log.indexOf('balance-start') < log.indexOf('order-done'), log.join(' '));
  const between = log.slice(log.indexOf('order-done'), log.indexOf('execute-start'));
  assert.ok(!between.includes('balance-start'), `no balance wait between quote and send: ${log.join(' ')}`);
  const rec = trader.trades[0];
  assert.ok(rec.timing && Number.isFinite(rec.timing.sendMs), 'send time recorded');
  assert.ok(Number.isFinite(rec.timing.quoteMs), 'quote time recorded');
});

test('speed: two buys at the same moment with SOL for only one: exactly one goes out', async () => {
  const { w, trader } = world({ sol: 0.32 }); // $50 = 0.25 SOL; 2 buys need 0.5 + reserve
  const { e, f } = engineFor(trader);
  const s2 = buySig(f);
  s2.token = { ...s2.token, address: 'MemeMint2222222222222222222222222222222pump' };
  await Promise.all([e.processTraderSignal(buySig(f)), e.processTraderSignal(s2)]);
  assert.equal(w.sent.length, 1, 'only one buy sent');
  assert.equal(e.positions.length, 1);
});

test('speed: a tight balance is still read fresh before the buy, and a short wallet is refused', async () => {
  const { w, trader } = world({ sol: 0.3 }); // $50 buy = 0.25 SOL + reserve: tight
  const { e, f } = engineFor(trader);
  await trader.refreshBalance();
  let balanceReads = 0;
  const rpc = trader.rpc;
  trader.rpc = (m, p) => {
    if (m === 'getBalance') balanceReads++;
    return rpc(m, p);
  };
  w.sol = 10_000_000n; // drained elsewhere since the last read
  await e.processTraderSignal(buySig(f));
  assert.ok(balanceReads >= 1, 'fresh read');
  assert.equal(e.positions.length, 0, 'refused: not enough SOL');
  assert.equal(w.sent.length, 0, 'nothing sent');
});

test("trader's own daily SOL limit: trims the buy that would cross it, then skips; failed buys give the room back", async () => {
  const { w, trader } = world({ sol: 5 });
  const { e, f } = engineFor(trader); // $50 buys = 0.25 SOL
  f.maxRealSolPerDay = 0.3;
  const mint2 = 'MemeMint2222222222222222222222222222222pump';
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 1, 'first buy');
  const s2 = buySig(f);
  s2.token = { ...s2.token, address: mint2 };
  await e.processTraderSignal(s2);
  const p2 = e.positions.find((p) => p.tokenAddress === mint2);
  assert.ok(p2, 'second buy trimmed to what is left');
  assert.ok(p2.initialCostUsd < 15, `trimmed to ~0.05 SOL ($10): ${p2.initialCostUsd}`);
  const s3 = buySig(f);
  s3.token = { ...s3.token, address: 'MemeMint3333333333333333333333333333333pump' };
  const [r3] = await e.processTraderSignal(s3);
  assert.match(r3.reason, /this trader's daily real-SOL limit reached \(0\.3 SOL\)/);
  assert.ok(Math.abs(e.traderRealSpent24hSol(f) - 0.3) < 0.02, `spent ${e.traderRealSpent24hSol(f)}`);
  // a buy that does not go through gives its reserved SOL back
  const { w: w2, trader: t2 } = world({ sol: 5, executeMode: 'fail' });
  const { e: e2, f: f2 } = engineFor(t2);
  f2.maxRealSolPerDay = 1;
  await e2.processTraderSignal(buySig(f2));
  assert.equal(e2.positions.length, 0);
  assert.equal(e2.traderRealSpent24hSol(f2), 0, 'reservation released');
  assert.ok(w2.sent.length >= 0 && w.sent.length === 2);
});

test('daily / per-buy SOL limits set on the dashboard win over the Railway variable; empty falls back', () => {
  const { trader } = world();
  assert.equal(trader.caps.maxSolPerDay, 2, 'variable default');
  let o = { maxSolPerDay: 5 };
  trader.capsOverride = () => o;
  assert.equal(trader.caps.maxSolPerDay, 5);
  assert.equal(trader.status().caps.maxSolPerDay, 5);
  assert.equal(trader.status().envCaps.maxSolPerDay, 2);
  o = { maxSolPerDay: 0 }; // 0 = no daily limit
  assert.equal(trader.caps.maxSolPerDay, 0);
  o = {};
  assert.equal(trader.caps.maxSolPerDay, 2, 'cleared → variable again');
  assert.equal(trader.caps.reserveSol, 0.02, 'fee reserve is not changeable from the dashboard');
});

test('entry ceiling: max chase caps the real fill price, not only the quote', async () => {
  const run = async (tokenPriceUsd, chase) => {
    const { w, trader, lastOrder } = world({ tokenPriceUsd });
    const { e, f } = engineFor(trader);
    f.maxChasePct = chase;
    const [r] = await e.processTraderSignal(buySig(f, 0.00002)); // trader paid $0.00002 per token
    return { w, e, r, lastOrder };
  };
  const ceiling = 0.00002 * 1.2;
  // quote ~+1% above the trader: 15% slippage still fits under the +20% ceiling → one quote
  let x = await run(0.00002, 20);
  assert.equal(x.e.positions.length, 1);
  assert.equal(x.w.orders, 1);
  assert.equal(x.lastOrder.slippageBps, '1500');
  // quote ~+13% above: slippage cut to what is left (~5.7%) and re-quoted, worst fill ≤ ceiling
  x = await run(0.0000224, 20);
  assert.equal(x.e.positions.length, 1, JSON.stringify(x.r));
  assert.equal(x.w.orders, 2, 'one fresh quote at the tighter slippage');
  const bps = Number(x.lastOrder.slippageBps);
  assert.ok(bps >= 500 && bps <= 600, `slippage ${bps} bps`);
  const quotePx = 0.0000224 / 0.99;
  assert.ok(quotePx / (1 - bps / 10000) <= ceiling * 1.0001, 'worst possible fill stays under the ceiling');
  // quote ~+19.7% above: no room left → skipped, nothing sent
  x = await run(0.0000237, 20);
  assert.equal(x.e.positions.length, 0);
  assert.equal(x.w.sent.length, 0);
  assert.match(x.r.reason, /more than your 20% max chase above the trader's price/);
  // "Copy every trade" (no chase limit): no ceiling, normal slippage
  x = await run(0.0000224, 1000);
  assert.equal(x.e.positions.length, 1);
  assert.equal(x.w.orders, 1);
  assert.equal(x.lastOrder.slippageBps, '1500');
});


test('direct send: a swap Jupiter reports as failed but our own copy landed is booked, never left untracked', async () => {
  const { w, trader } = world({ executeMode: 'fail-but-landed' });
  trader.fastRpcUrls = ['https://fast-rpc.example'];
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  assert.equal(e.positions.length, 1, 'position opened for the tokens that really landed');
  assert.ok(w.tok > 0n);
  // without the direct send (no fast RPCs) a Jupiter failure stays a failure
  const x = world({ executeMode: 'fail' });
  x.trader.fastRpcUrls = ['https://fast-rpc.example'];
  const y = engineFor(x.trader);
  await y.e.processTraderSignal(buySig(y.f));
  assert.equal(y.e.positions.length, 0);
});

test('fast fill path: a first buy still counts the token-account rent when the transaction is not read', async () => {
  const { w, trader } = world();
  w.hideTx = true;
  const { e, f } = engineFor(trader);
  await e.processTraderSignal(buySig(f));
  const p = e.positions[0];
  assert.ok(p, 'bought');
  const rec = e.history.find((h) => h.side === 'buy' && h.status === 'filled');
  assert.ok(rec.networkFeeUsd >= (2_039_280 / 1e9) * SOL_PX - 0.001, `network fee ${rec.networkFeeUsd} includes the ~0.002 SOL rent`);
});

test('EARNY race end-to-end: "trader sold" sells position A while B’s buy of the same coin is landing → B keeps its coins', async () => {
  const { w, trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  // top-ups on (the live setting): each top-up is its own position
  await e.processTraderSignal(buySig(f));
  const A = e.positions.find((p) => p.remainingTokens > 0);
  assert.ok(A, 'position A open');
  const tokA = w.tok;
  // B's buy: hold its Jupiter /execute until A's sell has gone out
  let releaseB;
  const gate = new Promise((r) => (releaseB = r));
  const realFetch = trader.fetch;
  let held = false;
  trader.fetch = async (url, opts) => {
    if (!held && String(url).includes('/execute')) {
      held = true;
      const res = await realFetch(url, opts); // B lands on-chain now (wallet holds A + B)…
      await gate; // …but the bot hasn't booked B yet
      return res;
    }
    return realFetch(url, opts);
  };
  const bDone = e.processTraderSignal(buySig(f));
  for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(held, 'B is landing');
  assert.ok(w.tok > tokA, 'wallet now holds A + B');
  const tokB = w.tok - tokA;
  const sell = await e.executePositionSell(A.id, { sellPct: 100, cause: 'trader sold' });
  assert.equal(sell.ok, true, sell.error);
  assert.equal(w.tok, tokB, 'only A’s coins were sold');
  releaseB();
  await bDone;
  const B = e.positions.find((p) => p.id !== A.id && p.remainingTokens > 0);
  assert.ok(B, 'position B booked and still open');
  assert.equal(A.remainingTokens, 0);
  assert.ok(Math.abs(B.remainingTokens * 1e6 - Number(tokB)) < 2, `B holds ${B.remainingTokens}, wallet has ${Number(tokB) / 1e6}`);
});

test('late-copy guard: a real copy more than 10 s after the trader is skipped; paper keeps 90 s', async () => {
  const { trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  const late = { ...buySig(f), ageSec: 11 };
  const r = await e.processTraderSignal(late);
  assert.equal(r[0].status, 'skipped');
  assert.match(r[0].reason, /too old to copy \(11s after the trader — limit 10s\)/);
  const fresh = await e.processTraderSignal({ ...buySig(f), ageSec: 3 });
  assert.equal(fresh[0].status, 'filled', fresh[0].reason);
  const p = engineFor(trader, { mode: 'buy-hold', paper: true });
  const pr = await p.e.processTraderSignal({ ...buySig(p.f), ageSec: 25 });
  assert.doesNotMatch(String(pr[0].reason || ''), /too old/);
});

test('trader-sold guard: a buy that reaches us after the trader already sold the coin is skipped (Soul)', async () => {
  const { trader } = world();
  const { e, f } = engineFor(trader, { mode: 'buy-hold' });
  // the trader's sell came in through the live feed 2 s ago; the buy (landed 10 s ago) arrives now
  e.traderLog = [{ t: Date.now() - 2000, w: f.traderWallet, mint: MINT, side: 'sell', copies: [] }];
  const r = await e.processTraderSignal({ ...buySig(f), ageSec: 10 });
  assert.equal(r[0].status, 'skipped');
  assert.match(r[0].reason, /already sold this coin/);
  // a sell from an earlier round (before this buy) does not block a new buy
  e.traderLog = [{ t: Date.now() - 60_000, w: f.traderWallet, mint: MINT, side: 'sell', copies: [] }];
  e.copiedCycles = {};
  const ok = await e.processTraderSignal({ ...buySig(f), ageSec: 2 });
  assert.equal(ok[0].status, 'filled', ok[0].reason);
});

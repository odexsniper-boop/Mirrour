// Behaviour-level regression tests for the Odex Mirror copy engine.
// Drives the real CopyTradingEngine with controlled prices and clock times, so each
// exit rule, filter and risk limit is checked at its exact threshold. Runs offline.
// Run: npm test   (or: node --test test/engine-behaviour.test.mjs)
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';

let seq = 0;
function makeEngine() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  return e;
}

function addFollow(e, over = {}) {
  const f = {
    id: `fol-${++seq}`,
    walletId: e.getActiveWallet().id,
    name: 'tester',
    handle: 'tester',
    traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
    chainId: 'solana',
    status: 'copying',
    pauseReason: null,
    mode: 'auto-exit',
    sizing: { type: 'fixed', amount: 75 },
    tpPct: null,
    slPct: null,
    minTradeUsd: 1,
    maxOpenPositions: 100,
    maxAtRiskUsd: 10000,
    consecutiveLosses: 0,
    exitRules: createDefaultExitRules(),
    filtersOverride: {},
    createdAt: Date.now(),
    ...over,
  };
  e.follows.unshift(f);
  return f;
}

function buySignal(f, tok = {}) {
  const id = ++seq;
  return {
    chainId: f.chainId,
    side: 'buy',
    traderHandle: f.handle,
    traderWallet: f.traderWallet,
    traderBuyUsd: 120,
    token: {
      address: `tok${id}Mint`,
      symbol: `T${id}`,
      name: `Token ${id}`,
      isLaunchpad: true,
      stage: 'pre-grad',
      marketCapUsd: 500_000,
      traderFillPriceUsd: 0.001,
      currentPriceUsd: 0.00104,
      safety: { safetyVerified: true },
      ...tok,
    },
  };
}

async function open(e, f, tok) {
  const [r] = await e.processTraderSignal(buySignal(f, tok));
  return r;
}

// Move a position to an exact % gain vs entry (updating peak like the real tick does)
function setGain(pos, pct) {
  pos.currentPriceUsd = pos.entryPriceUsd * (1 + pct / 100);
  pos.currentMarketCapUsd = Math.round(pos.entryMarketCapUsd * (1 + pct / 100));
  if (pos.currentPriceUsd > pos.peakPriceUsd) pos.peakPriceUsd = pos.currentPriceUsd;
}

const at = (pos, sec) => pos.openedAt + sec * 1000;
const lastSell = (e) => e.history.find((h) => h.side === 'sell');

// ---------------------------------------------------------------------------
// A. Copy pipeline
// ---------------------------------------------------------------------------
test('A1 pipeline: valid buy fills, records receipt, debits paper balance', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  const before = e.getSpendableBalanceUsd(e.getActiveWallet(), 'solana');
  const r = await open(e, f);
  assert.equal(r.status, 'filled');
  assert.equal(e.positions.length, 1);
  assert.equal(e.history[0].status, 'filled');
  assert.equal(r.position.sizeUsd, 75); // cost basis adds real gas + token-account rent on top
  const after = e.getSpendableBalanceUsd(e.getActiveWallet(), 'solana');
  assert.ok(before - after >= 75 && before - after < 76, `debited ${before - after}`);
});

test('A2 max chase boundary: 24% gap copies, 26% gap skips', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  const ok = await open(e, f, { currentPriceUsd: 0.00124 });
  assert.equal(ok.status, 'filled');
  const skip = await open(e, f, { currentPriceUsd: 0.00126 });
  assert.equal(skip.status, 'skipped');
  assert.match(skip.reason, /price moved too far/);
});

test('A3 safety: Solana freeze authority blocked when "block risky coins" is on', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  const r = await open(e, f, { safety: { freezeAuthority: true } });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /safety filter/);
});

test('A4 safety: EVM honeypot is hard-blocked regardless of settings', async () => {
  const e = makeEngine();
  e.settings.safety.blockRiskyCoins = false;
  const f = addFollow(e, { chainId: 'bsc', traderWallet: '0x71C95911E9a5D330f4D621842EC243EE1343292e' });
  const r = await open(e, f, { safety: { honeypot: true } });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /could not be sold safely/);
});

test('A5 safety: Solana honeypot / failed practice sale is blocked even with "block risky coins" off', async () => {
  const e = makeEngine();
  e.settings.safety.blockRiskyCoins = false;
  const f = addFollow(e);
  const r = await open(e, f, { safety: { honeypot: true, practiceSellFailed: true } });
  assert.equal(r.status, 'skipped', 'Solana token flagged honeypot/practice-sell-failed was copied');
});

test('A6 filters: pump-only and market-cap filters apply even when the follow has an empty override object', async () => {
  const e = makeEngine();
  const f = addFollow(e, { filtersOverride: {} });
  e.settings.filters.pumpOnly = true;
  const r1 = await open(e, f, { isLaunchpad: false });
  assert.equal(r1.status, 'skipped');
  e.settings.filters.pumpOnly = false;
  e.settings.filters.maxMarketCapUsd = 300_000;
  const r2 = await open(e, f, { marketCapUsd: 500_000 });
  assert.equal(r2.status, 'skipped');
  assert.match(r2.reason, /market cap/);
});

test('A7 cooldown: second buy of same token inside 10 min is skipped', async () => {
  const e = makeEngine();
  e.settings.copyTopUps = true; // this test is about the cooldown, not top-ups
  const f = addFollow(e);
  const tok = { address: 'sameTokMint', symbol: 'SAME' };
  assert.equal((await open(e, f, tok)).status, 'filled');
  const r = await open(e, f, tok);
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /cooldown/);
});

test('A8 sizing: percent-of-balance and proportional (capped) sizes', async () => {
  const e = makeEngine();
  const f = addFollow(e, { sizing: { type: 'percent', amount: 5 } });
  const r = await open(e, f);
  assert.equal(Math.round(r.position.initialCostUsd), 500); // 5% of $10,000 paper
  const g = addFollow(e, { handle: 'prop', traderWallet: 'PropWallet111111111111111111111111111', sizing: { type: 'proportional', amount: 50 } });
  const r2 = await open(e, g);
  assert.equal(r2.position.sizeUsd, 50); // min(trader $120, cap $50)
});

test('A9 limits: max open positions and paused follow skip new buys', async () => {
  const e = makeEngine();
  const f = addFollow(e, { maxOpenPositions: 1 });
  assert.equal((await open(e, f)).status, 'filled');
  const r = await open(e, f);
  assert.match(r.reason, /position limit/);
  f.status = 'paused';
  const r2 = await open(e, f);
  assert.match(r2.reason, /paused/);
});

test('A10 solana total exposure limit blocks the buy that would exceed it', async () => {
  const e = makeEngine();
  e.settings.risk.exposureLimitUsd = 100;
  const f = addFollow(e);
  assert.equal((await open(e, f)).status, 'filled'); // $75
  const r = await open(e, f); // would be $150
  assert.match(r.reason, /total exposure/);
});

// ---------------------------------------------------------------------------
// B. 5-rule auto-exit engine (each rule isolated, exact thresholds)
// ---------------------------------------------------------------------------
test('B1 Take Initials: +24% holds, +25% sells 75%, never fires twice', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.takeInitials.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, 24);
  await e.evaluatePositionExits(p, at(p, 5));
  assert.equal(p.initialsTaken, false);
  setGain(p, 25.01);
  await e.evaluatePositionExits(p, at(p, 6));
  assert.equal(p.initialsTaken, true);
  assert.equal(lastSell(e).cause, 'initials taken off');
  const ratio = p.remainingTokens / p.initialTokens;
  assert.ok(Math.abs(ratio - 0.25) < 0.001, `remaining ratio ${ratio}`);
  const sells = e.history.filter((h) => h.side === 'sell').length;
  setGain(p, 60);
  await e.evaluatePositionExits(p, at(p, 7));
  assert.equal(e.history.filter((h) => h.side === 'sell').length, sells);
});

test('B2 Moonbag Trail: arms at +10% peak, 24% off peak holds, 25% off peak sells all', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.moonbagTrail.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, 40); // peak +40%
  await e.evaluatePositionExits(p, at(p, 5));
  assert.equal(p.trailArmed, true);
  p.currentPriceUsd = p.peakPriceUsd * 0.76; // 24% off peak
  await e.evaluatePositionExits(p, at(p, 6));
  assert.ok(p.remainingTokens > 0);
  p.currentPriceUsd = p.peakPriceUsd * 0.749; // 25.1% off peak
  await e.evaluatePositionExits(p, at(p, 7));
  assert.equal(p.remainingTokens, 0);
  assert.equal(lastSell(e).cause, 'trailing stop hit');
});

test('B3 Moonbag Trail does not arm below +10% peak', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.moonbagTrail.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, 8);
  p.currentPriceUsd = p.peakPriceUsd * 0.6;
  await e.evaluatePositionExits(p, at(p, 5));
  assert.equal(p.trailArmed, false);
  assert.ok(p.remainingTokens > 0);
});

test('B4 Two-Stage Floor: -45% opening floor before 50s, tightens to -20% after', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.floor.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, -30);
  await e.evaluatePositionExits(p, at(p, 10));
  assert.ok(p.remainingTokens > 0, '-30% at 10s should hold (opening floor -45%)');
  setGain(p, -45.5);
  await e.evaluatePositionExits(p, at(p, 11));
  assert.equal(p.remainingTokens, 0);
  assert.equal(lastSell(e).cause, 'floor hit');

  const { position: q } = await open(e, f);
  setGain(q, -21);
  await e.evaluatePositionExits(q, at(q, 49));
  assert.ok(q.remainingTokens > 0, '-21% at 49s should hold');
  await e.evaluatePositionExits(q, at(q, 51));
  assert.equal(q.remainingTokens, 0, '-21% at 51s should hit tight floor');
});

test('B5 Wave-Cut: exits at 90s only if peak never reached +5%', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.waveCut.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, 3);
  await e.evaluatePositionExits(p, at(p, 89));
  assert.ok(p.remainingTokens > 0);
  await e.evaluatePositionExits(p, at(p, 90));
  assert.equal(p.remainingTokens, 0);
  assert.equal(lastSell(e).cause, 'no-wave exit');

  const { position: q } = await open(e, f);
  setGain(q, 6); // peak reached +6%
  setGain(q, 1);
  await e.evaluatePositionExits(q, at(q, 120));
  assert.ok(q.remainingTokens > 0, 'peak above +5% should survive wave-cut');
});

test('B6 Hard Time Cap: sells main bag at 300s, leaves moonbag when initials enabled', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.hardTimeCap.enabled = true;
  f.exitRules.takeInitials.enabled = true; // main bag = 75%
  const { position: p } = await open(e, f);
  setGain(p, 10);
  await e.evaluatePositionExits(p, at(p, 299));
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 1) < 1e-6);
  await e.evaluatePositionExits(p, at(p, 300));
  assert.equal(lastSell(e).cause, 'time cap reached');
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 0.25) < 0.001);
  const n = e.history.length;
  await e.evaluatePositionExits(p, at(p, 400));
  assert.equal(e.history.length, n, 'time cap must only fire once');
});

test('B7 Hard Time Cap alone sells 100%', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  f.exitRules.hardTimeCap.enabled = true;
  const { position: p } = await open(e, f);
  await e.evaluatePositionExits(p, at(p, 301));
  assert.equal(p.remainingTokens, 0);
});

test('B8 exit rules are ignored in Buy & Hold mode', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  for (const r of Object.values(f.exitRules)) r.enabled = true;
  const { position: p } = await open(e, f);
  setGain(p, -60);
  await e.evaluatePositionExits(p, at(p, 400));
  assert.ok(p.remainingTokens > 0);
});

test('B9 default exit rules are all OFF (new follows need rules enabled to auto-exit)', () => {
  const r = createDefaultExitRules();
  const on = Object.entries(r).filter(([, v]) => v.enabled).map(([k]) => k);
  assert.deepEqual(on, [], `enabled by default: ${on.join(',')}`);
});

// ---------------------------------------------------------------------------
// C. Follow TP/SL, mirror mode, leader sells
// ---------------------------------------------------------------------------
test('C1 follow TP/SL apply in every mode', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold', tpPct: 50, slPct: 25 });
  const { position: p } = await open(e, f);
  setGain(p, 49);
  await e.evaluatePositionExits(p, at(p, 3));
  assert.ok(p.remainingTokens > 0);
  setGain(p, 50.5);
  await e.evaluatePositionExits(p, at(p, 4));
  assert.equal(lastSell(e).cause, 'take-profit hit');

  const { position: q } = await open(e, f);
  setGain(q, -25.5);
  await e.evaluatePositionExits(q, at(q, 3));
  assert.equal(lastSell(e).cause, 'stop-loss hit');
});

test('C2 mirror mode copies a 50% leader sell', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'mirror' });
  const { position: p } = await open(e, f);
  await e.processTraderSignal({
    chainId: 'solana', side: 'sell', sellSharePct: 50,
    traderHandle: f.handle, traderWallet: f.traderWallet,
    token: { address: p.tokenAddress, symbol: p.symbol },
  });
  assert.equal(lastSell(e).cause, 'Mirror sell');
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 0.5) < 0.001);
});

test('C3 non-mirror modes skip leader sells', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit' });
  const { position: p } = await open(e, f);
  const [r] = await e.processTraderSignal({
    chainId: 'solana', side: 'sell', sellSharePct: 100,
    traderHandle: f.handle, traderWallet: f.traderWallet,
    token: { address: p.tokenAddress, symbol: p.symbol },
  });
  assert.equal(r.status, 'skipped');
  assert.ok(p.remainingTokens > 0);
});

// ---------------------------------------------------------------------------
// D. Armed limit orders
// ---------------------------------------------------------------------------
test('D1 limit TP (%) sells its size when hit', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  const { position: p } = await open(e, f);
  assert.equal(e.armLimitOrder(p.id, { type: 'take-profit', triggerType: 'pct', triggerValue: 30, sizePct: 40 }).ok, true);
  setGain(p, 29);
  await e.evaluatePositionExits(p, at(p, 2));
  assert.equal(p.armedOrders.length, 1);
  setGain(p, 31);
  await e.evaluatePositionExits(p, at(p, 3));
  assert.equal(p.armedOrders.length, 0);
  assert.equal(lastSell(e).cause, 'limit take-profit hit');
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 0.6) < 0.001);
});

test('D2 limit TP by market cap, limit SL, and sell-initials order', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  const { position: p } = await open(e, f);
  e.armLimitOrder(p.id, { type: 'take-profit', triggerType: 'mc', triggerValue: p.entryMarketCapUsd * 2, sizePct: 100 });
  setGain(p, 101);
  await e.evaluatePositionExits(p, at(p, 2));
  assert.equal(p.remainingTokens, 0);

  const { position: q } = await open(e, f);
  e.armLimitOrder(q.id, { type: 'stop-loss', triggerType: 'pct', triggerValue: 15, sizePct: 100 });
  setGain(q, -16);
  await e.evaluatePositionExits(q, at(q, 2));
  assert.equal(lastSell(e).cause, 'limit stop-loss hit');

  const { position: r } = await open(e, f);
  e.armLimitOrder(r.id, { type: 'sell-initials', triggerType: 'pct', triggerValue: 100 });
  setGain(r, 100);
  await e.evaluatePositionExits(r, at(r, 2));
  assert.equal(lastSell(e).cause, 'initials taken off');
  const left = r.remainingTokens * r.currentPriceUsd;
  assert.ok(left > 60 && left < 90, `moonbag value ${left}`); // ~half of $150 value stays
});

test('D3 limits: max 5 orders, TP sizes capped at 100%', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  const { position: p } = await open(e, f);
  assert.equal(e.armLimitOrder(p.id, { type: 'take-profit', triggerType: 'pct', triggerValue: 20, sizePct: 60 }).ok, true);
  assert.equal(e.armLimitOrder(p.id, { type: 'take-profit', triggerType: 'pct', triggerValue: 40, sizePct: 50 }).ok, false);
  for (let i = 0; i < 4; i++) e.armLimitOrder(p.id, { type: 'stop-loss', triggerType: 'pct', triggerValue: 10 + i, sizePct: 10 });
  assert.equal(p.armedOrders.length, 5);
  assert.equal(e.armLimitOrder(p.id, { type: 'stop-loss', triggerType: 'pct', triggerValue: 50, sizePct: 10 }).ok, false);
});

test('D4 a TP armed before a partial sell scales down instead of closing the whole remainder', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  const { position: p } = await open(e, f);
  e.armLimitOrder(p.id, { type: 'take-profit', triggerType: 'pct', triggerValue: 30, sizePct: 50 });
  await e.executePositionSell(p.id, { sellPct: 50, cause: 'manual sell' });
  setGain(p, 35);
  await e.evaluatePositionExits(p, at(p, 3));
  // The 50% TP must still sell 50% of what is left, not close the whole remainder
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 0.25) < 0.001, `remaining ratio ${p.remainingTokens / p.initialTokens}`);
});

// ---------------------------------------------------------------------------
// E. Panic sell, risk limits
// ---------------------------------------------------------------------------
test('E1 panic sell pauses every follow and closes every position', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  const g = addFollow(e, { handle: 'other', traderWallet: 'OtherWallet1111111111111111111111111' });
  await open(e, f);
  await open(e, g);
  const res = await e.sellAllPositions({ chainId: 'all', panic: true });
  assert.equal(res.soldCount, 2);
  assert.ok(e.positions.every((p) => p.remainingTokens === 0));
  assert.ok(e.follows.every((x) => x.status === 'paused' && x.pauseReason === 'panic_sell'));
  assert.match((await open(e, f)).reason, /paused/);
});

test('E2 losing streak limit pauses the follow after N losses', async () => {
  const e = makeEngine();
  e.settings.risk.streakLimit = 2;
  const f = addFollow(e, { slPct: 20 });
  for (let i = 0; i < 2; i++) {
    const { position: p } = await open(e, f);
    setGain(p, -30);
    await e.evaluatePositionExits(p, at(p, 2));
  }
  assert.equal(f.status, 'paused');
  assert.equal(f.pauseReason, 'streak');
  assert.match((await open(e, f)).reason, /paused|risk protection/);
});

test('E3 daily loss limit triggers on the very trade that crosses it', async () => {
  const e = makeEngine();
  e.settings.risk.dailyLossLimitUsd = 20;
  const f = addFollow(e, { slPct: 30 });
  const { position: p } = await open(e, f);
  setGain(p, -40);
  await e.evaluatePositionExits(p, at(p, 2));
  assert.equal(e.settings.risk.dailyLossTriggered, true);
  assert.match((await open(e, f)).reason, /risk protection/);
});

// ---------------------------------------------------------------------------
// F. Execution edge cases & accounting
// ---------------------------------------------------------------------------
test('F1 round trip: paper balance = start − buy cost + sell proceeds', async () => {
  const e = makeEngine();
  const f = addFollow(e);
  const w = e.getActiveWallet();
  const start = e.getSpendableBalanceUsd(w, 'solana');
  const { position: p } = await open(e, f);
  setGain(p, 20);
  const res = await e.executePositionSell(p.id, { sellPct: 100, cause: 'manual sell' });
  const end = w.paperBalanceUsd;
  const expected = start - 75 - e.history.find((h) => h.side === 'buy').networkFeeUsd + res.receipt.amountUsd;
  assert.ok(Math.abs(end - expected) < 0.05, `end ${end} expected ${expected}`);
  assert.ok(res.receipt.pnlUsd > 0);
});

test('F2 manual "sell initials" recovers cost and leaves the profit', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'buy-and-hold' });
  const { position: p } = await open(e, f);
  setGain(p, 100);
  const r = await e.sellInitialsManual(p.id);
  assert.equal(r.ok, true);
  assert.ok(p.remainingTokens > 0);
  // Proceeds recover the original $75 cost, less platform fee and price impact (< $1.50)
  assert.ok(75 - r.receipt.amountUsd < 1.5, `proceeds ${r.receipt.amountUsd}`);
  const moonbag = p.remainingTokens * p.currentPriceUsd;
  assert.ok(moonbag > 70 && moonbag < 80, `moonbag ${moonbag}`);
});

test('F3 large Solana position: stop-loss executes via auto-widening sell slippage', async () => {
  const e = makeEngine();
  const f = addFollow(e, { sizing: { type: 'fixed', amount: 1000 }, slPct: 25 });
  const { position: p } = await open(e, f, { marketCapUsd: 280_000 }); // ~$61.6k liquidity
  setGain(p, -30);
  const r = await e.evaluatePositionExits(p, at(p, 2));
  assert.equal(p.remainingTokens, 0, `stop-loss did not execute: ${r && r.error}`);
});

test('F4 BSC buy uses dynamic slippage and records gasless USDC fill', async () => {
  const e = makeEngine();
  const f = addFollow(e, { chainId: 'bsc', traderWallet: '0x71C95911E9a5D330f4D621842EC243EE1343292e' });
  const r = await open(e, f);
  assert.equal(r.status, 'filled');
  assert.equal(r.receipt.gasless, true);
});

test('F5 a sell slippage set in Settings stays a hard cap (no auto-widening)', async () => {
  const e = makeEngine();
  e.settings.sellSlippagePct = 1;
  const f = addFollow(e, { sizing: { type: 'fixed', amount: 1000 }, slPct: 25 });
  const { position: p } = await open(e, f, { marketCapUsd: 280_000 });
  setGain(p, -30);
  const r = await e.evaluatePositionExits(p, at(p, 2));
  assert.equal(r.ok, false);
  assert.ok(p.remainingTokens > 0);
});

test('F6 a blocked auto-exit retried every tick raises one alert per minute, not one per tick', async () => {
  const e = makeEngine();
  e.settings.sellSlippagePct = 1;
  const f = addFollow(e, { sizing: { type: 'fixed', amount: 1000 }, slPct: 25 });
  const { position: p } = await open(e, f, { marketCapUsd: 280_000 });
  setGain(p, -30);
  for (let i = 0; i < 5; i++) await e.evaluatePositionExits(p, at(p, 2 + i * 2));
  const blocked = e.alerts.filter((a) => a.title.startsWith('Sell not executed'));
  assert.equal(blocked.length, 1);
});

test('F7 leader-sell skip message names the actual mode', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit' });
  const { position: p } = await open(e, f);
  const [r] = await e.processTraderSignal({
    chainId: 'solana', side: 'sell', sellSharePct: 100,
    traderHandle: f.handle, traderWallet: f.traderWallet,
    token: { address: p.tokenAddress, symbol: p.symbol },
  });
  assert.match(r.reason, /Auto-Exit/);
  assert.doesNotMatch(r.reason, /Buy & Hold/);
});

// ---------------------------------------------------------------------------
// Follow the trader: Auto-Exit that also sells when the trader sells
// ---------------------------------------------------------------------------

const traderSell = (f, p, pct) => ({
  chainId: 'solana', side: 'sell', sellSharePct: pct,
  traderHandle: f.handle, traderWallet: f.traderWallet,
  token: { address: p.tokenAddress, symbol: p.symbol, traderFillPriceUsd: p.entryPriceUsd },
});

test('FT1 Auto-Exit + "sell when the trader sells": their full exit closes the whole position', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit', mirrorSells: true });
  const { position: p } = await open(e, f);
  await e.processTraderSignal(traderSell(f, p, 100));
  assert.equal(lastSell(e).cause, 'trader sold');
  assert.equal(p.remainingTokens, 0, 'closed');
});

test('FT2 a trader selling half or more is their exit: we sell everything (every exit closes the position)', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit', mirrorSells: true });
  const { position: p } = await open(e, f);
  await e.processTraderSignal(traderSell(f, p, 60));
  assert.equal(p.remainingTokens, 0);
});

test('FT3 a small trader trim is mirrored as it is, not as a full exit', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit', mirrorSells: true });
  const { position: p } = await open(e, f);
  await e.processTraderSignal(traderSell(f, p, 25));
  assert.ok(Math.abs(p.remainingTokens / p.initialTokens - 0.75) < 0.001, `${p.remainingTokens / p.initialTokens}`);
});

test('FT4 without the switch, Auto-Exit still ignores trader sells', async () => {
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit', mirrorSells: false });
  const { position: p } = await open(e, f);
  const [r] = await e.processTraderSignal(traderSell(f, p, 100));
  assert.equal(r.status, 'skipped');
  assert.ok(p.remainingTokens > 0);
});

test('FT5 Follow the trader preset: +12% take profit sells all, no trail, −40% floor, 5 min cap', async () => {
  const { followTraderExitRules } = await import('../engine/copyEngine.mjs');
  const r = followTraderExitRules();
  assert.deepEqual([r.takeInitials.enabled, r.takeInitials.takeAtPct, r.takeInitials.sellSizePct], [true, 12, 100]);
  assert.equal(r.moonbagTrail.enabled, false);
  assert.deepEqual([r.floor.enabled, r.floor.openingFloorPct, r.floor.tightFloorPct], [true, 40, 40]);
  assert.equal(r.waveCut.enabled, false);
  assert.deepEqual([r.hardTimeCap.enabled, r.hardTimeCap.timeCapSec], [true, 300]);
  // on a position: a −30% dip the trader holds through does NOT sell; −40% does; +12% does
  const e = makeEngine();
  const f = addFollow(e, { mode: 'auto-exit', mirrorSells: true, exitRules: r });
  const { position: p } = await open(e, f);
  setGain(p, -30);
  await e.evaluatePositionExits(p, at(p, 20));
  assert.ok(p.remainingTokens > 0, 'held through a −30% dip');
  setGain(p, -40.5);
  await e.evaluatePositionExits(p, at(p, 25));
  assert.equal(p.remainingTokens, 0, 'floor sold at −40%');
  const { position: q } = await open(e, f);
  setGain(q, 12.5);
  await e.evaluatePositionExits(q, at(q, 10));
  assert.equal(q.remainingTokens, 0, 'take profit sold everything');
  const { position: z } = await open(e, f);
  setGain(z, 3);
  await e.evaluatePositionExits(z, at(z, 301));
  assert.equal(z.remainingTokens, 0, '5 min cap');
});

test('FT6 fast exit checks reuse a DexScreener price for 1.5 s instead of asking again', async () => {
  const e = makeEngine();
  let calls = 0;
  e.priceFetch = async (url) => {
    calls++;
    const mint = String(url).split('/').pop();
    return { ok: true, json: async () => ({ pairs: [{ baseToken: { address: mint }, priceUsd: '0.002', liquidity: { usd: 1000 } }] }) };
  };
  const M = 'X'.repeat(40);
  e.livePriceMinAgeMs = 1500;
  const a = await e.fetchLivePrices([M]);
  const b = await e.fetchLivePrices([M]);
  assert.equal(calls, 1, 'second check within 1.5 s used the cached price');
  assert.equal(b.get(M).priceUsd, a.get(M).priceUsd);
  e.livePriceMinAgeMs = 0; // tests / default: always fresh
  await e.fetchLivePrices([M]);
  assert.equal(calls, 2);
});

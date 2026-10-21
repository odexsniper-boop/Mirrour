process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';

function setupTestFollow(engine, overrides = {}) {
  const activeWallet = engine.getActiveWallet();
  activeWallet.balances.solana.stable = 1000;
  activeWallet.balances.solana.native = 5;
  const follow = {
    id: `fol-${Math.random().toString(36).slice(2, 8)}`,
    walletId: activeWallet.id,
    name: 'Whale 1',
    handle: 'whale1',
    traderWallet: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv',
    chainId: 'solana',
    status: 'copying',
    pauseReason: null,
    mode: 'auto-exit',
    sizing: { type: 'fixed', amount: 50 },
    exitRules: createDefaultExitRules({
      takeInitials: { enabled: true, takeAtPct: 25, sellSizePct: 75 },
      moonbagTrail: { enabled: true, trailPct: 25, armsAtPct: 10 },
      ...(overrides.exitRules || {}),
    }),
    ...overrides,
  };
  engine.follows.push(follow);
  return follow;
}

test('CopyTradingEngine: 6-step copy pipeline executes valid buy and records receipt', async () => {
  const engine = new CopyTradingEngine();
  setupTestFollow(engine);
  const initialCount = engine.positions.length;

  const results = await engine.processTraderSignal({
    chainId: 'solana',
    side: 'buy',
    traderHandle: 'whale1',
    traderWallet: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv',
    traderBuyUsd: 200,
    token: {
      address: 'TestSolTokenMint1111111111111111111111111',
      symbol: 'TESTCOIN',
      name: 'Test Coin',
      isLaunchpad: true,
      stage: 'pre-grad',
      marketCapUsd: 250_000,
      traderFillPriceUsd: 0.00025,
      currentPriceUsd: 0.00026, // +4% chase, below 25% Max Chase
      safety: { safetyVerified: true },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'filled');
  assert.equal(engine.positions.length, initialCount + 1);
  assert.equal(results[0].position.symbol, 'TESTCOIN');
  assert.equal(results[0].receipt.gasless, true);
});

test('CopyTradingEngine: Max Chase skips buy when price ran past 25% limit', async () => {
  const engine = new CopyTradingEngine();
  setupTestFollow(engine);

  const results = await engine.processTraderSignal({
    chainId: 'solana',
    side: 'buy',
    traderHandle: 'whale1',
    traderWallet: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv',
    traderBuyUsd: 150,
    token: {
      address: 'ChaseSolTokenMint111111111111111111111111',
      symbol: 'CHASER',
      isLaunchpad: true,
      stage: 'graduated',
      marketCapUsd: 600_000,
      traderFillPriceUsd: 0.0002,
      currentPriceUsd: 0.0003, // +50% chase (> 25% Max Chase)
      safety: { safetyVerified: true },
    },
  });

  assert.equal(results[0].status, 'skipped');
  assert.equal(results[0].reason, 'price moved too far before we could copy');
});

test('CopyTradingEngine: Safety filter blocks freeze authority & honeypot tokens', async () => {
  const engine = new CopyTradingEngine();
  setupTestFollow(engine);

  const results = await engine.processTraderSignal({
    chainId: 'solana',
    side: 'buy',
    traderHandle: 'whale1',
    traderWallet: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv',
    traderBuyUsd: 150,
    token: {
      address: 'RiskySolTokenMint111111111111111111111111',
      symbol: 'FREEZE',
      isLaunchpad: false,
      marketCapUsd: 400_000,
      traderFillPriceUsd: 0.0004,
      currentPriceUsd: 0.00041,
      safety: { freezeAuthority: true, safetyVerified: true },
    },
  });

  assert.equal(results[0].status, 'skipped');
  assert.equal(results[0].reason, 'blocked by your safety filter');
});

test('CopyTradingEngine: 5-Rule Auto-Exit Engine triggers Take Initials (+25% -> sell 75%) and Moonbag Trail', async () => {
  const engine = new CopyTradingEngine();
  const follow = setupTestFollow(engine, { mode: 'auto-exit' });
  const pos = {
    id: 'test-pos-exit',
    walletId: engine.getActiveWallet().id,
    followId: follow.id,
    traderHandle: follow.handle,
    chainId: 'solana',
    tokenAddress: 'TestMint111',
    symbol: 'TEST',
    name: 'Test Token',
    tradingAssetUsed: 'stable',
    entryPriceUsd: 0.00042,
    currentPriceUsd: 0.000596, // +41.9%
    peakPriceUsd: 0.00062,
    entryMarketCapUsd: 420_000,
    currentMarketCapUsd: 596_000,
    peakMarketCapUsd: 620_000,
    liquidityUsd: 100_000,
    initialCostUsd: 50.00,
    remainingCostUsd: 50.00,
    initialTokens: 119047,
    remainingTokens: 119047,
    realizedPnlUsd: 0,
    openedAt: Date.now() - 30_000,
    initialsTaken: false,
    trailArmed: false,
    armedOrders: [],
  };
  engine.positions.push(pos);

  // Price is already +41.9% above entry ($0.00042 -> $0.000596), so first evaluation triggers Take Initials (75% sell)
  const exitRes = await engine.evaluatePositionExits(pos, Date.now());
  assert.ok(exitRes);
  assert.equal(exitRes.receipt.cause, 'initials taken off');
  assert.equal(pos.initialsTaken, true);
  // 25% moonbag remains
  assert.ok(Math.abs(pos.remainingCostUsd - 12.5) < 0.01);

  // Now drop price 30% from peak ($0.00062 -> $0.00041) to trigger Moonbag Trail (25% off peak)
  pos.currentPriceUsd = 0.00041;
  const trailRes = await engine.evaluatePositionExits(pos, Date.now());
  assert.ok(trailRes);
  assert.equal(trailRes.receipt.cause, 'trailing stop hit');
  assert.equal(pos.remainingTokens, 0);
});

test('CopyTradingEngine: Per-position Armed Limit Orders enforce max 5 orders & <=100% TP cap', async () => {
  const engine = new CopyTradingEngine();
  const pos = {
    id: 'test-pos-arm',
    chainId: 'solana',
    tokenAddress: 'TestMint222',
    symbol: 'ARMTEST',
    name: 'Arm Test',
    strategy: 'auto-exit',
    copiedTrader: '@whale1',
    entryPriceUsd: 0.0001,
    currentPriceUsd: 0.0001,
    entryMcUsd: 100_000,
    currentMcUsd: 100_000,
    initialCostUsd: 50,
    remainingCostUsd: 50,
    initialTokens: 500000,
    remainingTokens: 500000,
    enteredAt: Date.now(),
    initialsTaken: false,
    armedOrders: [
      { id: 'arm-1', type: 'take-profit', triggerType: 'mc', triggerValue: 1_000_000, sizePct: 50, createdAt: Date.now() },
    ],
  };
  engine.positions.push(pos);

  const overCap = engine.armLimitOrder(pos.id, {
    type: 'take-profit',
    triggerType: 'pct',
    triggerValue: 200,
    sizePct: 60, // 50% + 60% = 110% > 100%
  });
  assert.equal(overCap.ok, false);

  const valid = engine.armLimitOrder(pos.id, {
    type: 'take-profit',
    triggerType: 'pct',
    triggerValue: 200,
    sizePct: 50, // 50% + 50% = 100%
  });
  assert.equal(valid.ok, true);
});

import { recommendedExitRules, activeExitRuleCount, createDefaultExitRules as cder } from '../engine/copyEngine.mjs';
test('recommended exits: all five rules on, defaults off', () => {
  assert.equal(activeExitRuleCount(recommendedExitRules()), 5);
  assert.equal(activeExitRuleCount(cder()), 0);
});

test('auto-exit with recommended rules cuts a dumping copy at the floor', async () => {
  const { CopyTradingEngine } = await import('../engine/copyEngine.mjs');
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  e.follows.push({ id: 'f1', walletId: e.getActiveWallet().id, name: 'x', handle: 'x', traderWallet: W, chainId: 'solana', status: 'copying', mode: 'auto-exit', sizing: { type: 'fixed', amount: 10 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 5, maxAtRiskUsd: 100, consecutiveLosses: 0, exitRules: recommendedExitRules(), filtersOverride: {} });
  await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderHandle: 'x', traderWallet: W, traderBuyUsd: 50, token: { address: 'mintDump1', symbol: 'DUMP', isLaunchpad: true, marketCapUsd: 12000, traderFillPriceUsd: 0.0000127, currentPriceUsd: 0.000012, safety: {} } });
  const pos = e.positions[0];
  assert.ok(pos, 'copied');
  pos.currentPriceUsd = pos.entryPriceUsd * 0.52; // the real test: token fell 48%
  await e.evaluatePositionExits(pos, pos.openedAt + 21_000);
  assert.equal(pos.remainingTokens, 0, 'floor (−45%) sold the whole position');
});

test('closed positions: bought / sold / PnL / opened + closed times are reported after a full sell', async () => {
  const { CopyTradingEngine } = await import('../engine/copyEngine.mjs');
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  e.follows.push({ id: 'f1', walletId: e.getActiveWallet().id, name: 'x', handle: 'x', traderWallet: W, chainId: 'solana', status: 'copying', mode: 'buy-and-hold', sizing: { type: 'fixed', amount: 20 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 5, maxAtRiskUsd: 100, consecutiveLosses: 0, exitRules: cder(), filtersOverride: {} });
  await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderHandle: 'x', traderWallet: W, traderBuyUsd: 50, token: { address: 'mintClosed1pump', symbol: 'CLS', isLaunchpad: true, marketCapUsd: 20000, traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002, safety: {} } });
  const pos = e.positions[0];
  assert.equal(e.getStateSnapshot().closedPositions.length, 0);
  pos.currentPriceUsd = pos.entryPriceUsd * 1.5;
  await e.executePositionSell(pos.id, { sellPct: 50 });
  assert.equal(e.getStateSnapshot().closedPositions.length, 0, 'half sold is still open');
  await e.executePositionSell(pos.id, { sellPct: 100 });
  const [c] = e.getStateSnapshot().closedPositions;
  assert.ok(c, 'appears once fully sold');
  assert.equal(c.symbol, 'CLS');
  assert.ok(c.boughtUsd >= 20 && c.boughtUsd - 20 < 0.6, `bought = $20 order + gas/rent (${c.boughtUsd})`);
  assert.ok(Math.abs(c.soldTokens - c.boughtTokens) < 1e-3, 'all tokens sold');
  assert.ok(c.soldUsd > 28 && c.soldUsd < 30.1, `sold ${c.soldUsd} (≈ +50% minus fees)`);
  assert.ok(Math.abs(c.pnlUsd - (c.soldUsd - c.boughtUsd)) < 0.01);
  assert.ok(c.pnlPct > 40 && c.pnlPct < 50);
  assert.ok(c.closedAt >= c.openedAt);
  assert.equal(c.closeCause, 'manual sell');
  assert.equal(e.getStateSnapshot().positions.length, 0, 'not in open positions any more');
});

test('PnL calendar groups realized sells by local day, splits paper/real and finds best/worst day', () => {
  const engine = new CopyTradingEngine({ autoStart: false });
  const at = (iso) => Date.parse(iso);
  engine.realizedLog = [
    { t: at('2026-10-03T10:00:00Z'), pnl: 12.5, paper: true },
    { t: at('2026-10-03T12:00:00Z'), pnl: -2.5, paper: true },
    { t: at('2026-10-07T23:30:00Z'), pnl: -8, paper: true }, // 7 Oct UTC, 8 Oct at UTC+2
    { t: at('2026-10-07T09:00:00Z'), pnl: 100, paper: false }, // real trade: not in paper view
    { t: at('2026-09-30T09:00:00Z'), pnl: 5, paper: true }, // other month
  ];
  const utc = engine.pnlCalendar({ year: 2026, month: 10, tzOffsetMin: 0, paper: true });
  assert.equal(utc.days[3].pnl, 10);
  assert.equal(utc.days[3].trades, 2);
  assert.equal(utc.days[7].pnl, -8);
  assert.equal(utc.total, 2);
  assert.deepEqual(utc.wins, { count: 1, usd: 12.5 });
  assert.deepEqual(utc.losses, { count: 2, usd: -10.5 });
  assert.deepEqual(utc.best, { day: 3, pnl: 10 });
  assert.deepEqual(utc.worst, { day: 7, pnl: -8 });
  assert.equal(utc.firstTradeAt, at('2026-09-30T09:00:00Z'));
  // UTC+2: getTimezoneOffset() is -120
  const plus2 = engine.pnlCalendar({ year: 2026, month: 10, tzOffsetMin: -120, paper: true });
  assert.equal(plus2.days[7], undefined);
  assert.equal(plus2.days[8].pnl, -8);
  const real = engine.pnlCalendar({ year: 2026, month: 10, paper: false });
  assert.equal(real.total, 100);
  assert.equal(real.worst, null);
});

test('closed positions report SOL invested / returned at the SOL price of each trade', async () => {
  const { CHAINS } = await import('../engine/chainAdapters.mjs');
  const before = CHAINS.solana.nativePriceUsd;
  try {
    const e = new CopyTradingEngine();
    e.resetToCleanState();
    e.settings.paperTrading = true;
    const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    e.follows.push({ id: 'f1', walletId: e.getActiveWallet().id, name: 'x', handle: 'x', traderWallet: W, chainId: 'solana', status: 'copying', mode: 'buy-and-hold', sizing: { type: 'fixed', amount: 20 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 5, maxAtRiskUsd: 100, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {} });
    CHAINS.solana.nativePriceUsd = 200;
    await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderHandle: 'x', traderWallet: W, traderBuyUsd: 50, token: { address: 'mintSol1pump', symbol: 'SL', isLaunchpad: true, marketCapUsd: 20000, traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002, safety: {} } });
    const pos = e.positions[0];
    assert.ok(pos.investedSol >= 0.1 && pos.investedSol < 0.103, `$20 at $200/SOL + gas/rent (${pos.investedSol})`);
    CHAINS.solana.nativePriceUsd = 100; // SOL halves before the sell
    await e.executePositionSell(pos.id, { sellPct: 100 });
    const [c] = e.getStateSnapshot().closedPositions;
    assert.equal(c.solExact, true);
    assert.ok(c.boughtSol >= 0.1 && c.boughtSol < 0.103, `$20 order + gas/rent at $200/SOL (${c.boughtSol})`);
    assert.ok(Math.abs(c.soldSol - c.soldUsd / 100) < 1e-3, 'returned SOL uses the SOL price at the sell');
    assert.ok(Math.abs(c.pnlSol - (c.soldSol - c.boughtSol)) < 1e-3);
    // an older record without SOL fields falls back to today's price and is flagged
    delete pos.investedSol;
    delete pos.soldSol;
    const [old] = e.getStateSnapshot().closedPositions;
    assert.equal(old.solExact, false);
    assert.ok(Math.abs(old.boughtSol - old.boughtUsd / 100) < 1e-3, 'falls back to today\'s $100 SOL price');
  } finally {
    CHAINS.solana.nativePriceUsd = before;
  }
});

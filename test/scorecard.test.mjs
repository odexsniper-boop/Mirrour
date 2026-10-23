// Trader scorecard: win rate, hold time, slip vs the trader, detection delay, auto-pause.
// Run: node --test test/scorecard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';

CHAINS.solana.nativePriceUsd = 200;
const MINT = 'ScoreMint11111111111111111111111111111111';

function setup() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  e.settings.cooldown.enabled = false;
  e.settings.copyTopUps = true;
  e.settings.maxChasePct = 1000;
  const f = {
    id: 'fol-sc', walletId: e.getActiveWallet().id, name: 't', handle: 'trader', traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ', chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'mirror', sizing: { type: 'fixed', amount: 50 }, tpPct: null, slPct: null, minTradeUsd: 1,
    maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);
  return { e, f };
}
const tok = (px, mint) => ({ address: mint, symbol: 'SC', name: 'Score', isLaunchpad: false, stage: 'graduated', marketCapUsd: 5_000_000, liquidityUsd: 2_000_000, traderFillPriceUsd: px, currentPriceUsd: px, safety: { safetyVerified: true } });

/** one copied round trip: trader buys at 1.00, we copy at `ourEntry`; trader sells at `traderExit` */
async function roundTrip(e, f, i, { ourEntry = 1.05, traderExit = 1.2, lag = 2 } = {}) {
  const mint = `${MINT.slice(0, -4)}${String(i).padStart(4, '0')}`;
  const buy = { chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: `b${i}`, ageSec: lag, token: { ...tok(1, mint), currentPriceUsd: ourEntry } };
  const [r] = await e.processTraderSignal(buy);
  assert.equal(r.status, 'filled', JSON.stringify(r));
  const pos = e.positions.find((p) => p.tokenAddress === mint);
  pos.currentPriceUsd = traderExit;
  const sell = { chainId: 'solana', side: 'sell', sellSharePct: 100, traderWallet: f.traderWallet, signature: `s${i}`, token: tok(traderExit, mint) };
  await e.processTraderSignal(sell);
  assert.equal(pos.remainingTokens, 0);
  return pos;
}

test('scorecard: win rate, hold time, entry/exit slip and delay come from the copies', async () => {
  const { e, f } = setup();
  for (let i = 0; i < 4; i++) await roundTrip(e, f, i, { ourEntry: 1.05, traderExit: i < 3 ? 1.3 : 0.8, lag: 3 });
  const sc = e.traderScorecard(f.id);
  assert.equal(sc.trades, 4);
  assert.equal(sc.wins, 3);
  assert.equal(sc.losses, 1);
  assert.equal(sc.winRatePct, 75);
  assert.ok(sc.avgEntrySlipPct > 4 && sc.avgEntrySlipPct < 7, `entry slip ~5% (${sc.avgEntrySlipPct})`);
  assert.ok(sc.avgExitSlipPct <= 0 && sc.measuredExits === 4, `mirror exits measured, never above the trader (${sc.avgExitSlipPct})`);
  assert.equal(sc.avgLagSec, 3);
  assert.ok(Number.isFinite(sc.avgHoldSec));
  assert.ok(e.getStateSnapshot().traderScores[f.id].trades === 4, 'sent to the browser');
});

test('auto-pause: a trader the bot falls far behind is paused after enough copies; resume judges fresh trades', async () => {
  const { e, f } = setup();
  e.settings.scorecard = { autoPause: true, minTrades: 3, maxSlipPct: 20, maxLagSec: 10 };
  for (let i = 0; i < 2; i++) await roundTrip(e, f, i, { ourEntry: 1.4, traderExit: 1.5 });
  assert.equal(f.status, 'copying', 'not judged before 3 copies');
  await roundTrip(e, f, 2, { ourEntry: 1.4, traderExit: 1.5 });
  assert.equal(f.status, 'paused');
  assert.equal(f.pauseReason, 'slow');
  assert.match(f.pauseDetail, /lose/);
  assert.ok(e.alerts.some((a) => /can't keep up/.test(a.title)));
  // a buy while paused is not copied
  const [r] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: 'bx', ageSec: 1, token: tok(1, `${MINT.slice(0, -4)}9999`) });
  assert.equal(r.status, 'skipped');
  // resumed: only trades after the resume count
  f.status = 'copying';
  f.pauseReason = null;
  f.scoreSince = Date.now() + 1;
  await new Promise((res) => setTimeout(res, 5));
  await roundTrip(e, f, 10, { ourEntry: 1.02, traderExit: 1.5 });
  assert.equal(f.status, 'copying', 'old slow trades do not re-pause it');
});

test('auto-pause: slow detection alone also pauses; auto-pause off only reports', async () => {
  const { e, f } = setup();
  e.settings.scorecard = { autoPause: true, minTrades: 2, maxSlipPct: 50, maxLagSec: 10 };
  for (let i = 0; i < 2; i++) await roundTrip(e, f, i, { ourEntry: 1.01, traderExit: 1.2, lag: 25 });
  assert.equal(f.pauseReason, 'slow');
  assert.match(f.pauseDetail, /late/);
  const b = setup();
  b.e.settings.scorecard = { autoPause: false, minTrades: 2, maxSlipPct: 5, maxLagSec: 1 };
  for (let i = 0; i < 3; i++) await roundTrip(b.e, b.f, i, { ourEntry: 1.4, traderExit: 1.5, lag: 30 });
  assert.equal(b.f.status, 'copying');
});

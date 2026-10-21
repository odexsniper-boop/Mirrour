/**
 * Dedicated Agent Test: Copy Trading Engine in Paper Trading Simulation Mode
 * Tests all 5 pipeline phases without real funds (0.00 SOL balance)
 */
const BASE_URL = 'http://localhost:3400';

console.log('================================================================');
console.log('🤖 AGENT TEST: COPY TRADING ENGINE IN PAPER TRADING MODE');
console.log(`Target: ${BASE_URL} | Time: ${new Date().toISOString()}`);
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`❌ [FAIL] ${message}`);
    failCount++;
  }
}

async function run() {
  try {
    // Reset to clean state
    await fetch(`${BASE_URL}/api/engine/reset`, { method: 'POST' });

    // Step 1: Query initial state
    const stateRes = await fetch(`${BASE_URL}/api/state`);
    const stateData = await stateRes.json();
    assert(stateData.ok && stateData.state.settings.paperTrading === true, 'Paper Trading is ON by default');
    
    const wallet = stateData.state.wallets[0];
    assert(wallet.balances.solana.native === 0, 'Real Solana balance is 0.00 SOL (no real crypto required)');

    // Step 2: Create a trader follow in paper mode
    const followRes = await fetch(`${BASE_URL}/api/follows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: 'frankdegods',
        traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
        chainId: 'solana',
        mode: 'auto-exit',
        sizing: { type: 'fixed', amount: 75 },
        tpPct: 50,
        slPct: 25,
        exitRules: {
          takeInitials: { enabled: true, takeAtPct: 25, sellSizePct: 75 },
          moonbagTrail: { enabled: true, trailPct: 20, armsAtPct: 15 },
          floor: { enabled: true, openingFloorPct: 40, tightensAfterSec: 60, tightFloorPct: 20 },
          waveCut: { enabled: false },
          hardTimeCap: { enabled: true, timeCapSec: 600 },
        },
      }),
    });
    const followData = await followRes.json();
    assert(followRes.status === 200 && followData.ok, 'Paper follow created for @frankdegods');
    const followId = followData.created[0].id;

    // Step 3: Test Scenario 1 - Normal Buy Signal (6-Step Copy Pipeline)
    const buyRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'normal_buy', followId }),
    });
    const buyData = await buyRes.json();
    const filled = buyData.results?.find((r) => r.status === 'filled');
    assert(buyRes.status === 200 && filled !== undefined, 'Paper Copy Buy executed successfully (6-step pipeline)');
    assert(filled.position.isPaper === true, 'Position tagged with isPaper: true');
    assert(filled.receipt.isPaper === true, 'Receipt tagged with isPaper: true');

    const stateAfterBuy = await (await fetch(`${BASE_URL}/api/state`)).json();
    const activeWallet = stateAfterBuy.state.wallets[0];
    assert(activeWallet.balances.solana.native === 0, 'Real Solana balance remains 0.00 SOL (not debited)');
    assert(stateAfterBuy.state.positionsSummary.openCount === 1, 'Open positions count is 1');
    const posId = filled.position.id;

    // Step 4: Test Scenario 2 - Max Chase Skip (25% Threshold)
    const chaseRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'high_chase_skip', followId }),
    });
    const chaseData = await chaseRes.json();
    const chaseSkip = chaseData.results?.find((r) => r.status === 'skipped');
    assert(chaseSkip !== undefined, 'Max chase buy correctly skipped');
    assert(chaseSkip.reason?.includes('price moved too far'), 'Skip reason: "price moved too far before we could copy"');
    const gap = chaseSkip.chaseGapPct ?? chaseSkip.entry?.chaseGapPct;
    assert(gap > 25, `Chase gap detected (${gap}%) > 25% limit`);

    // Step 5: Test Scenario 3 - Malicious Honeypot & Freeze Authority Block
    const honeyRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'honeypot_skip', followId }),
    });
    const honeyData = await honeyRes.json();
    const honeySkip = honeyData.results?.find((r) => r.status === 'skipped');
    assert(honeySkip !== undefined, 'Malicious token correctly blocked by security filter');
    assert(honeySkip.reason?.includes('safety filter'), 'Skip reason: "blocked by your safety filter"');

    // Step 6: Test Scenario 4 - 5-Rule Auto-Exit Engine (+35% Price Pump)
    const pumpRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'pump_open_positions' }),
    });
    const pumpData = await pumpRes.json();
    assert(pumpRes.status === 200 && pumpData.ok, 'Market tick (+35% pump) applied');

    // Check exit trigger in state
    const stateAfterPump = await (await fetch(`${BASE_URL}/api/state`)).json();
    const takeInitialsReceipt = stateAfterPump.state.history.find(
      (h) => h.cause === 'initials taken off' || h.cause?.includes('initials')
    );
    assert(takeInitialsReceipt !== undefined, '5-Rule Auto-Exit triggered: "initials taken off" (+25% gain -> 75% bag sold)');
    if (takeInitialsReceipt) {
      assert(takeInitialsReceipt.pnlUsd > 0, `Profit realized in paper trading: +$${takeInitialsReceipt.pnlUsd}`);
    }

    // Step 7: Test Scenario 5 - Manual Sell / Close Position
    const closeRes = await fetch(`${BASE_URL}/api/positions/${posId}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fraction: 1.0, cause: 'manual sell' }),
    });
    const closeData = await closeRes.json();
    assert(closeRes.status === 200 && closeData.ok, 'Manual sell executed on remaining bag');

    const stateAfterClose = await (await fetch(`${BASE_URL}/api/state`)).json();
    assert(stateAfterClose.state.positionsSummary.openCount === 0, 'All positions closed cleanly');
    assert(activeWallet.balances.solana.native === 0, 'Real Solana balance still 0.00 SOL');

    // Step 8: Clean Reset
    await fetch(`${BASE_URL}/api/engine/reset`, { method: 'POST' });
    const cleanFinal = await (await fetch(`${BASE_URL}/api/state`)).json();
    assert(cleanFinal.state.positions.length === 0, 'Clean baseline: 0 open positions');
    assert(cleanFinal.state.follows.length === 0, 'Clean baseline: 0 follows');
    assert(cleanFinal.state.history.length === 0, 'Clean baseline: 0 history items');

    console.log('\n================================================================');
    console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
    console.log('================================================================');

    if (failCount > 0) process.exit(1);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

run();

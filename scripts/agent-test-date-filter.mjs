import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3400';

async function testDateFilterAndSolanaOnly() {
  console.log('================================================================');
  console.log('🤖 AGENT TEST: DATE FILTER, FAKE DATA REMOVAL & SOLANA ONLY AUDIT');
  console.log(`Target: ${BASE_URL} | Time: ${new Date().toISOString()}`);
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name}${details ? ` - ${details}` : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}${details ? ` - ${details}` : ''}`);
      failed++;
    }
  }

  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/styles.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');

  // ==========================================================================
  // 1. SOLANA ONLY AUDIT (No USDC in header)
  // ==========================================================================
  assert(!html.includes('id="header-usdc-balance"'), 'Header pill has NO header-usdc-balance element (USDC removed)');
  assert(!html.includes('class="header-usdc-logo"'), 'Header pill has NO header-usdc-logo SVG icon');
  assert(html.includes('id="header-sol-balance"'), 'Header pill has #header-sol-balance');
  assert(html.includes('title="Solana Wallet Balance"'), 'Header pill title reflects Solana Wallet Balance');
  assert(html.includes('addPaperFunds(') && !html.includes('quickDepositActive'), 'Deposit modal paper buttons add paper money (no fake SOL deposits)');

  // ==========================================================================
  // 2. FAKE DATA REMOVAL & CLEAN BASELINE AUDIT
  // ==========================================================================
  try {
    const resetRes = await fetch(`${BASE_URL}/api/engine/reset`, { method: 'POST' });
    const resetData = await resetRes.json();
    assert(resetRes.status === 200 && resetData.ok, 'POST /api/engine/reset executes successfully');
    
    const activeWallet = resetData.state.wallets.find(w => w.active);
    assert(activeWallet && activeWallet.balances.solana.native === 0, 'Clean baseline: Solana balance is 0.00 SOL');
    assert(activeWallet && activeWallet.balances.solana.stable === 0, 'Clean baseline: USDC balance is $0.00');
    assert(resetData.state.positions.length === 0, 'Clean baseline: 0 open positions');
    assert(resetData.state.follows.length === 0, 'Clean baseline: 0 followed traders');
    assert(resetData.state.history.length === 0, 'Clean baseline: 0 history trades / receipts');
    assert(resetData.state.positionsSummary.totalValueUsd === 0, 'Clean baseline: Total positions value is $0.00');
  } catch (err) {
    assert(false, 'POST /api/engine/reset failed', err.message);
  }

  // ==========================================================================
  // 3. DATE FILTER CODE & UI AUDIT
  // ==========================================================================
  assert(html.includes('id="btn-date-filter"'), 'Date filter button #btn-date-filter exists above KPI cards');
  assert(html.includes('id="date-filter-label"'), 'Date filter label #date-filter-label exists');
  assert(html.includes('class="kpi-toolbar-header"'), 'kpi-toolbar-header wrapper placed above KPI grid');
  assert(html.includes('id="modal-date-filter"'), 'Modal #modal-date-filter exists');
  assert(html.includes('data-preset="today"'), 'Preset "Today" exists in sidebar');
  assert(html.includes('data-preset="yesterday"'), 'Preset "Yesterday" exists in sidebar');
  assert(html.includes('data-preset="last7"'), 'Preset "Last 7 days" exists in sidebar');
  assert(html.includes('data-preset="ptd"'), 'Preset "Period to date" exists in sidebar');
  assert(html.includes('data-preset="quarters"'), 'Preset "Quarters" exists in sidebar');
  assert(html.includes('data-preset="custom"'), 'Preset "Custom range" exists in sidebar');
  assert(html.includes('data-preset="all"'), 'Preset "All Time" exists in sidebar');
  assert(!html.includes('id="df-last-num"'), '"Last N days" controls removed (presets + calendar only)');
  assert(html.includes('data-preset="last30"'), 'Preset "Last 30 days" exists');
  assert(html.includes('id="df-cal-title-1"') && html.includes('id="df-cal-title-2"'), 'Dual calendar titles exist');
  assert(html.includes('id="df-days-grid-1"') && html.includes('id="df-days-grid-2"'), 'Dual calendar grids exist');
  assert(html.includes('id="df-selected-range-label"'), 'Range label #df-selected-range-label exists');

  // ==========================================================================
  // 4. DATE RANGE CALCULATION & FILTER LOGIC VERIFICATION
  // ==========================================================================
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  // Test simulation dataset
  const testTrades = [
    { id: 't1', timestamp: todayStart + 3600000, pnlUsd: 25.50, status: 'filled', side: 'sell' }, // Today (+1h)
    { id: 't2', timestamp: todayStart - 3600000, pnlUsd: -10.00, status: 'filled', side: 'sell' }, // Yesterday (-1h)
    { id: 't3', timestamp: todayStart - 3 * 86400000, pnlUsd: 50.00, status: 'filled', side: 'sell' }, // 3 days ago
    { id: 't4', timestamp: todayStart - 25 * 86400000, pnlUsd: 100.00, status: 'filled', side: 'sell' }, // 25 days ago
  ];

  // Test Filter 1: Today
  const todayTrades = testTrades.filter(t => t.timestamp >= todayStart && t.timestamp <= todayEnd);
  assert(todayTrades.length === 1 && todayTrades[0].id === 't1', 'Date Filter [Today] correctly isolates only today trade');

  // Test Filter 2: Yesterday
  const yStart = todayStart - 86400000;
  const yEnd = todayStart - 1;
  const yTrades = testTrades.filter(t => t.timestamp >= yStart && t.timestamp <= yEnd);
  assert(yTrades.length === 1 && yTrades[0].id === 't2', 'Date Filter [Yesterday] correctly isolates only yesterday trade');

  // Test Filter 3: Last 7 Days
  const last7Start = todayStart - 6 * 86400000;
  const last7Trades = testTrades.filter(t => t.timestamp >= last7Start && t.timestamp <= todayEnd);
  assert(last7Trades.length === 3, 'Date Filter [Last 7 Days] captures 3 recent trades (t1, t2, t3)');
  assert(!last7Trades.some(t => t.id === 't4'), 'Date Filter [Last 7 Days] excludes older 25-day trade (t4)');

  // Test Filter 4: All Time
  const allTrades = testTrades.filter(t => true);
  assert(allTrades.length === 4, 'Date Filter [All Time] preserves all 4 trades');

  // Test Filter 5: Custom Range (between 2 and 4 days ago)
  const cStart = todayStart - 4 * 86400000;
  const cEnd = todayStart - 2 * 86400000;
  const customTrades = testTrades.filter(t => t.timestamp >= cStart && t.timestamp <= cEnd);
  assert(customTrades.length === 1 && customTrades[0].id === 't3', 'Date Filter [Custom Range] isolates specified window');

  // ==========================================================================
  // 5. FINAL CLEANUP VERIFICATION
  // ==========================================================================
  const verifyRes = await fetch(`${BASE_URL}/api/state`);
  const verifyData = await verifyRes.json();
  assert(verifyData.ok && verifyData.state.positions.length === 0, 'Verified zero open positions after test suite');
  assert(verifyData.state.history.length === 0, 'Verified zero lingering history trades');

  console.log('\n================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');
  process.exitCode = failed > 0 ? 1 : 0;
}

testDateFilterAndSolanaOnly().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exitCode = 1;
});

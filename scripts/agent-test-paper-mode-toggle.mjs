import fs from 'node:fs';

const BASE_URL = 'http://localhost:3400';

async function testPaperMode() {
  console.log('================================================================');
  console.log('🤖 AGENT TEST: PAPER TRADING SIMULATION MODE TOGGLE');
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

  // 1. Static HTML & CSS Audit
  assert(html.includes('class="paper-mode-card"'), 'Paper mode card container exists in index.html');
  assert(html.includes('<span class="pm-title">Paper Trading</span>'), 'Title "Paper Trading" (bracketed text removed 2026-10-18)');
  assert(html.includes('Simulate live execution without risking real funds.'), 'Subtitle text matches screenshot');
  assert(html.includes('id="toggle-paper-mode"'), 'Checkbox #toggle-paper-mode exists');
  assert(html.includes('id="pm-switch-capsule"'), 'Capsule #pm-switch-capsule exists');
  assert(html.includes('id="pm-status-text"'), 'Status text #pm-status-text exists');
  assert(css.includes('.paper-mode-card') && css.includes('.pm-switch-capsule'), 'Paper mode styles defined in styles.css');
  assert(js.includes('window.togglePaperModeClick') && js.includes('window.onPaperModeToggle'), 'JS handlers defined in app.js');

  // 2. Initial State Verification (Default Paper Mode = ON)
  try {
    const res = await fetch(`${BASE_URL}/api/state`);
    const data = await res.json();
    assert(res.status === 200 && data.ok, 'GET /api/state returns 200 OK');
    assert(data.state.settings.paperTrading === true, 'Initial setting: paperTrading is enabled (ON) by default');
  } catch (err) {
    assert(false, 'GET /api/state failed', err.message);
  }

  // 3. Toggle OFF: Switch to Live Mode
  try {
    const offRes = await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperTrading: false }),
    });
    const offData = await offRes.json();
    assert(offRes.status === 200 && offData.ok, 'POST /api/settings (paperTrading: false) returns 200');
    assert(offData.state.settings.paperTrading === false, 'Setting updated: paperTrading is now FALSE (Live Mode)');
  } catch (err) {
    assert(false, 'Toggle OFF failed', err.message);
  }

  // 4. Toggle ON: Switch back to Paper Trading Mode
  try {
    const onRes = await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperTrading: true }),
    });
    const onData = await onRes.json();
    assert(onRes.status === 200 && onData.ok, 'POST /api/settings (paperTrading: true) returns 200');
    assert(onData.state.settings.paperTrading === true, 'Setting updated: paperTrading is restored to TRUE (Simulation Mode)');
  } catch (err) {
    assert(false, 'Toggle ON failed', err.message);
  }

  // 5. Test Paper Execution Simulation
  try {
    // Deposit paper capital
    await fetch(`${BASE_URL}/api/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'paper-funds', walletId: 'w-main', amountUsd: 500 }),
    });
    await fetch(`${BASE_URL}/api/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'paper-funds', reset: true }),
    });

    // Create follow
    const folRes = await fetch(`${BASE_URL}/api/follows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Paper Test Follow',
        handle: 'frankdegods',
        traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
        chainId: 'solana',
        sizing: { type: 'fixed', amount: 50 },
      }),
    });
    const folData = await folRes.json();
    const folId = folData.created?.[0]?.id;
    assert(folId, 'Paper follow created successfully');

    // Simulate signal buy
    const sigRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'normal_buy', followId: folId }),
    });
    const sigData = await sigRes.json();
    const posId = sigData.state?.positions?.[0]?.id;
    assert(posId, `Paper buy filled in simulation mode: Position ${posId}`);

    // Sell position
    if (posId) {
      const sellRes = await fetch(`${BASE_URL}/api/positions/${posId}/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharePct: 100 }),
      });
      const sellData = await sellRes.json();
      assert(sellRes.status === 200 && sellData.ok, 'Paper position closed cleanly with 100% fill');
    }

    // Delete follow
    await fetch(`${BASE_URL}/api/follows/${folId}`, { method: 'DELETE' });
  } catch (err) {
    assert(false, 'Paper execution flow failed', err.message);
  }

  // 6. Cleanup to Clean Baseline
  try {
    await fetch(`${BASE_URL}/api/engine/reset`, { method: 'POST' });
    const cleanRes = await fetch(`${BASE_URL}/api/state`);
    const cleanData = await cleanRes.json();
    assert(cleanData.state.positions.length === 0, 'Clean baseline verified: 0 positions');
    assert(cleanData.state.history.length === 0, 'Clean baseline verified: 0 history trades');
  } catch (err) {
    assert(false, 'Clean baseline reset failed', err.message);
  }

  console.log('\n================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');
  process.exitCode = failed > 0 ? 1 : 0;
}

testPaperMode().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exitCode = 1;
});

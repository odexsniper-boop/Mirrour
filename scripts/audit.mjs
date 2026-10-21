import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3400';

async function runAudit() {
  const findings = [];
  const passes = [];

  function recordPass(testName, detail = '') {
    passes.push({ testName, detail });
    console.log(`[PASS] ${testName}${detail ? ` - ${detail}` : ''}`);
  }

  function recordFail(testName, error, severity = 'high') {
    findings.push({ testName, error, severity });
    console.error(`[FAIL] [${severity.toUpperCase()}] ${testName}: ${error}`);
  }

  console.log('====================================================');
  console.log('STAGE 1: STATIC CODE AUDIT (HTML vs JS SYMBOL MATCH)');
  console.log('====================================================');

  const html = fs.readFileSync('public/index.html', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');

  // 1. Check getElementById references
  const getElemRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  const missingIds = [];
  let m;
  while ((m = getElemRegex.exec(js)) !== null) {
    const id = m[1];
    if (id.includes('${') || id.startsWith('lim-') || id.startsWith('card-pnl-') || id.startsWith('fol-name-')) {
      continue;
    }
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      if (!missingIds.includes(id)) missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    recordFail('DOM Element ID Audit', `The following IDs are referenced in app.js but missing in index.html: ${missingIds.join(', ')}`, 'high');
  } else {
    recordPass('DOM Element ID Audit', 'All getElementById targets exist in index.html');
  }

  // 2. Check onclick / onchange handlers in index.html against window / app.js
  const onclickRegex = /on(?:click|change|submit)=["']([a-zA-Z0-9_]+)\(/g;
  const missingHandlers = [];
  while ((m = onclickRegex.exec(html)) !== null) {
    const fnName = m[1];
    // check if function is defined in js
    const hasDef =
      js.includes(`function ${fnName}`) ||
      js.includes(`window.${fnName}`) ||
      js.includes(`const ${fnName} =`) ||
      js.includes(`let ${fnName} =`);
    if (!hasDef && !missingHandlers.includes(fnName)) {
      missingHandlers.push(fnName);
    }
  }

  if (missingHandlers.length > 0) {
    recordFail('HTML Event Handlers Audit', `The following functions called in HTML attributes are missing in app.js: ${missingHandlers.join(', ')}`, 'high');
  } else {
    recordPass('HTML Event Handlers Audit', 'All inline HTML event handlers are defined in app.js');
  }

  console.log('\n====================================================');
  console.log('STAGE 2: END-TO-END API & PIPELINE AUDIT');
  console.log('====================================================');

  // Test 1: Health & State
  try {
    const res = await fetch(`${BASE_URL}/api/state`);
    const data = await res.json();
    if (res.status === 200 && data.ok && data.state) {
      recordPass('GET /api/state', `Wallet count: ${data.state.wallets.length}`);
    } else {
      recordFail('GET /api/state', `Invalid response: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    recordFail('GET /api/state', err.message);
  }

  // Test 2: fomo leaderboard removed — copying is wallet-only
  try {
    const res = await fetch(`${BASE_URL}/api/leaderboard`);
    if (res.status === 404) recordPass('Leaderboard removed', '/api/leaderboard is gone');
    else recordFail('Leaderboard removed', `Expected 404, got ${res.status}`);
  } catch (err) {
    recordFail('Leaderboard removed', err.message);
  }

  // Test 3: follow requires a real Solana wallet (no fallback trader)
  try {
    const res = await fetch(`${BASE_URL}/api/follows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'someone' }) });
    if (res.status === 400) recordPass('POST /api/follows without wallet', 'Rejected with 400');
    else recordFail('POST /api/follows without wallet', `Expected 400, got ${res.status}`);
  } catch (err) {
    recordFail('POST /api/follows without wallet', err.message);
  }

  // Test 4: wallet check validates input
  try {
    const res = await fetch(`${BASE_URL}/api/traders/check?address=xyz`);
    if (res.status === 400) recordPass('GET /api/traders/check (invalid)', 'Rejected with 400');
    else recordFail('GET /api/traders/check (invalid)', `Expected 400, got ${res.status}`);
  } catch (err) {
    recordFail('GET /api/traders/check (invalid)', err.message);
  }

  // Test 5: Deposit Funds to Active Wallet (so copy trading can execute)
  let activeWalletId = null;
  try {
    const stRes = await fetch(`${BASE_URL}/api/state`);
    const stData = await stRes.json();
    activeWalletId = stData.state.activeWalletId;

    const depRes = await fetch(`${BASE_URL}/api/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'paper-funds',
        walletId: activeWalletId,
        amountUsd: 500,
      }),
    });
    const depData = await depRes.json();
    if (depRes.status === 200 && depData.ok) {
      const w = depData.state.wallets.find((x) => x.id === activeWalletId);
      recordPass('POST /api/wallets (paper-funds)', `Added $500 paper money to "${w.name}". Paper balance: $${w.paperBalanceUsd}`);
    } else {
      recordFail('POST /api/wallets (deposit)', `Deposit failed: ${JSON.stringify(depData)}`);
    }
  } catch (err) {
    recordFail('POST /api/wallets (deposit)', err.message);
  }

  // Test 6: Create Follow
  let createdFollowId = null;
  try {
    const folRes = await fetch(`${BASE_URL}/api/follows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'FrankDeGods Test',
        handle: 'frankdegods',
        traderWallet: 'DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv',
        chainId: 'solana',
        mode: 'auto-exit',
        sizing: { type: 'fixed', amount: 50 },
        tpPct: 150,
        slPct: 50,
        exitRules: {
          takeInitials: { enabled: true, takeAtPct: 25, sellSizePct: 75 },
          moonbagTrail: { enabled: true, trailPct: 25, armsAtPct: 10 },
        },
      }),
    });
    const folData = await folRes.json();
    if (folRes.status === 200 && folData.ok && folData.created?.length > 0) {
      createdFollowId = folData.created[0].id;
      recordPass('POST /api/follows (Create Follow)', `Created follow ID: ${createdFollowId} (@${folData.created[0].handle})`);
    } else {
      recordFail('POST /api/follows (Create Follow)', `Follow creation failed: ${JSON.stringify(folData)}`);
    }
  } catch (err) {
    recordFail('POST /api/follows (Create Follow)', err.message);
  }

  // Test 7: Update Follow Settings
  if (createdFollowId) {
    try {
      const upRes = await fetch(`${BASE_URL}/api/follows/${createdFollowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'FrankDeGods Updated',
          sizing: { type: 'fixed', amount: 75 },
        }),
      });
      const upData = await upRes.json();
      if (upRes.status === 200 && upData.ok && upData.follow.name === 'FrankDeGods Updated') {
        recordPass('PATCH /api/follows/:id', 'Updated follow name and sizing');
      } else {
        recordFail('PATCH /api/follows/:id', `Update failed: ${JSON.stringify(upData)}`);
      }
    } catch (err) {
      recordFail('PATCH /api/follows/:id', err.message);
    }
  }

  // Test 8: Simulate Normal Buy Signal (Copy Pipeline Execution)
  let createdPositionId = null;
  try {
    const simRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'normal_buy',
        followId: createdFollowId,
      }),
    });
    const simData = await simRes.json();
    const filled = simData.results?.find((r) => r.status === 'filled');
    if (simRes.status === 200 && filled) {
      createdPositionId = filled.position.id;
      recordPass('POST /api/simulate-signal (normal_buy)', `Bought $${filled.position.symbol} (${filled.position.id})`);
    } else {
      recordFail('POST /api/simulate-signal (normal_buy)', `Buy simulation failed: ${JSON.stringify(simData)}`);
    }
  } catch (err) {
    recordFail('POST /api/simulate-signal (normal_buy)', err.message);
  }

  // Test 9: Simulate High Chase Skip Signal
  try {
    const skipRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'high_chase_skip',
        followId: createdFollowId,
      }),
    });
    const skipData = await skipRes.json();
    const skipped = skipData.results?.find((r) => r.status === 'skipped');
    if (skipRes.status === 200 && skipped && skipped.reason?.includes('price moved too far')) {
      recordPass('POST /api/simulate-signal (high_chase_skip)', `Correctly skipped: "${skipped.reason}"`);
    } else {
      recordFail('POST /api/simulate-signal (high_chase_skip)', `Expected max chase skip, got: ${JSON.stringify(skipData)}`);
    }
  } catch (err) {
    recordFail('POST /api/simulate-signal (high_chase_skip)', err.message);
  }

  // Test 10: Simulate Honeypot Filter Skip Signal
  try {
    const honeyRes = await fetch(`${BASE_URL}/api/simulate-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'honeypot_skip',
        followId: createdFollowId,
      }),
    });
    const honeyData = await honeyRes.json();
    const honeySkipped = honeyData.results?.find((r) => r.status === 'skipped');
    if (honeyRes.status === 200 && honeySkipped && honeySkipped.reason?.includes('blocked by your safety filter')) {
      recordPass('POST /api/simulate-signal (honeypot_skip)', `Correctly blocked by safety filter: "${honeySkipped.reason}"`);
    } else {
      recordFail('POST /api/simulate-signal (honeypot_skip)', `Expected honeypot block, got: ${JSON.stringify(honeyData)}`);
    }
  } catch (err) {
    recordFail('POST /api/simulate-signal (honeypot_skip)', err.message);
  }

  // Test 11: Arm Limit Order on Position
  let armedOrderId = null;
  if (createdPositionId) {
    try {
      const armRes = await fetch(`${BASE_URL}/api/positions/${createdPositionId}/limit-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'take-profit',
          triggerType: 'pct',
          triggerValue: 100,
          sizePct: 50,
        }),
      });
      const armData = await armRes.json();
      if (armRes.status === 200 && armData.ok && armData.order) {
        armedOrderId = armData.order.id;
        recordPass('POST /api/positions/:id/limit-orders', `Armed order ${armedOrderId} (TP +100%, 50% size)`);
      } else {
        recordFail('POST /api/positions/:id/limit-orders', `Failed to arm order: ${JSON.stringify(armData)}`);
      }
    } catch (err) {
      recordFail('POST /api/positions/:id/limit-orders', err.message);
    }
  }

  // Test 12: Cancel Limit Order
  if (createdPositionId && armedOrderId) {
    try {
      const canRes = await fetch(`${BASE_URL}/api/positions/${createdPositionId}/limit-orders/${armedOrderId}`, {
        method: 'DELETE',
      });
      const canData = await canRes.json();
      if (canRes.status === 200 && canData.ok) {
        recordPass('DELETE /api/positions/:id/limit-orders/:orderId', 'Successfully cancelled armed order');
      } else {
        recordFail('DELETE /api/positions/:id/limit-orders/:orderId', `Failed to cancel order: ${JSON.stringify(canData)}`);
      }
    } catch (err) {
      recordFail('DELETE /api/positions/:id/limit-orders/:orderId', err.message);
    }
  }

  // Test 13: Nudge Price & Trigger Take Initials Auto-Exit
  if (createdPositionId) {
    try {
      // Pump price by 40% to trigger +25% Take Initials
      const pumpRes = await fetch(`${BASE_URL}/api/positions/${createdPositionId}/nudge-price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier: 1.40 }),
      });
      const pumpData = await pumpRes.json();
      const pos = pumpData.state.positions.find((p) => p.id === createdPositionId);
      if (pumpRes.status === 200 && pumpData.ok) {
        recordPass('POST /api/positions/:id/nudge-price', `Price pumped +40%. Position initialsTaken=${pos?.initialsTaken}`);
      } else {
        recordFail('POST /api/positions/:id/nudge-price', `Nudge price failed: ${JSON.stringify(pumpData)}`);
      }
    } catch (err) {
      recordFail('POST /api/positions/:id/nudge-price', err.message);
    }
  }

  // Test 14: Manual Sell Remaining Position
  if (createdPositionId) {
    try {
      const sellRes = await fetch(`${BASE_URL}/api/positions/${createdPositionId}/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellPct: 100 }),
      });
      const sellData = await sellRes.json();
      if (sellRes.status === 200 && sellData.ok) {
        recordPass('POST /api/positions/:id/sell', `Closed 100% of position. PnL: $${sellData.receipt?.pnlUsd}`);
      } else {
        recordFail('POST /api/positions/:id/sell', `Sell failed: ${JSON.stringify(sellData)}`);
      }
    } catch (err) {
      recordFail('POST /api/positions/:id/sell', err.message);
    }
  }

  // Test 15: Settings Update & Validation
  try {
    const setRes = await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxChasePct: 30,
        filters: { pumpOnly: true },
      }),
    });
    const setData = await setRes.json();
    if (setRes.status === 200 && setData.ok && setData.state.settings.maxChasePct === 30) {
      recordPass('POST /api/settings', 'Updated maxChasePct to 30% and pumpOnly to true');
    } else {
      recordFail('POST /api/settings', `Settings update failed: ${JSON.stringify(setData)}`);
    }
  } catch (err) {
    recordFail('POST /api/settings', err.message);
  }

  // Test 16: Relay Bridge Simulation
  try {
    const brRes = await fetch(`${BASE_URL}/api/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'bridge',
        fromChain: 'solana',
        toChain: 'bsc',
        amountUsd: 50,
      }),
    });
    if (brRes.status === 410) {
      recordPass('POST /api/wallets (bridge)', 'Simulated bridge is refused (no fake money movement)');
    } else {
      recordFail('POST /api/wallets (bridge)', `Expected 410, got ${brRes.status}`);
    }
  } catch (err) {
    recordFail('POST /api/wallets (bridge)', err.message);
  }

  // Test 17: Cleanup - Delete Follow
  if (createdFollowId) {
    try {
      const delRes = await fetch(`${BASE_URL}/api/follows/${createdFollowId}`, {
        method: 'DELETE',
      });
      const delData = await delRes.json();
      if (delRes.status === 200 && delData.ok) {
        recordPass('DELETE /api/follows/:id', 'Deleted test follow cleanly');
      } else {
        recordFail('DELETE /api/follows/:id', `Delete follow failed: ${JSON.stringify(delData)}`);
      }
    } catch (err) {
      recordFail('DELETE /api/follows/:id', err.message);
    }
  }

  // Test 18: Reset All Settings to Default
  try {
    const rstRes = await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    const rstData = await rstRes.json();
    if (rstRes.status === 200 && rstData.ok && rstData.state.settings.maxChasePct === 25) {
      recordPass('POST /api/settings (reset)', 'Settings reset to default values (25% max chase)');
    } else {
      recordFail('POST /api/settings (reset)', `Reset failed: ${JSON.stringify(rstData)}`);
    }
  } catch (err) {
    recordFail('POST /api/settings (reset)', err.message);
  }

  // Cleanup: Reset engine state to clean baseline (no fake/leftover test data)
  try {
    await fetch(`${BASE_URL}/api/engine/reset`, { method: 'POST' });
  } catch {
    // ignore
  }

  console.log('\n====================================================');
  console.log('AUDIT SUMMARY');
  console.log('====================================================');
  console.log(`Total Passed: ${passes.length}`);
  console.log(`Total Findings/Failures: ${findings.length}`);
  if (findings.length > 0) {
    console.log('\n--- FINDINGS DETAILS ---');
    for (const f of findings) {
      console.log(`[${f.severity.toUpperCase()}] ${f.testName}: ${f.error}`);
    }
  }

  return { passes, findings };
}

runAudit().catch(console.error);

process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bondingCurvePda, parseBondingCurve, curveMetrics, fetchPumpCurves, PUMP_PROGRAM } from '../engine/pumpCurve.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';

// Real mainnet data (20 Oct 2026): SolanaGO's bonding curve; DexScreener showed $0.00001159 / MC $11,591 at the same time
const SOLANAGO = '6TnNgprbRAFk3SApRw4rkLGkeUamVpSuUup8GAtNpump';
const SOLANAGO_CURVE = 'F7f4N2DYrGCJ7DjHwewBAPfgWNUNAAAAiVQmezDuAAD3NDXZBgAAAACAxqR+jQMAAJGLbqNZF4oKY6We' + 'A'.repeat(20);
const MSTR_CURVE = 'F7f4N2DYrGAL/eqcm64DABnd8Y0AAAAAC2XYUAqwAgDONtcEAAAAAACAxqR+jQMAAKCTB7HDwmRLq9tWCaNEiL0HOcKXlwfvT6zgJDT0ouZ2AAAH6GQDr4/7hr/jR4j1xEPaNktHfAwlEW5lvGMMMBHIJB4AAAAAAAAAAAEdWAEAAAAAANggAgAAAAAAAEumGokAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

test('P1 bonding-curve address matches mainnet', () => {
  assert.equal(bondingCurvePda(SOLANAGO), 'GKxDmnD8NVwtf4S8MUk3tka68ydafuTG1LLqJepwb8M7');
  assert.equal(bondingCurvePda('7xXPtTHg8MA3RmgDJKksqWaeity77k9zyTSjjdmHUwJf'), 'HB43Ga39bLBNj9d9kLFyBAsg2Yke18bgt9dhEeWNsGNs');
});

test('P2 real curve → price, market cap and real liquidity agree with DexScreener', () => {
  const m = curveMetrics(parseBondingCurve(SOLANAGO_CURVE), 105.59);
  assert.ok(Math.abs(m.priceUsd / 0.00001159 - 1) < 0.01, `price ${m.priceUsd}`);
  assert.ok(Math.abs(m.marketCapUsd - 11591) < 150, `mc ${m.marketCapUsd}`);
  assert.ok(Math.abs(m.liquidityUsd - 29.41 * 105.59 * 2) < 20, `liquidity ${m.liquidityUsd}`);
});

test('P3 non-standard curves are not trusted', () => {
  assert.equal(curveMetrics(parseBondingCurve(MSTR_CURVE), 105.59), null);
});

test('P4 engine: open pump position gets live price/MC/liquidity from the curve every tick; no invented liquidity', async () => {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  e.follows.push({ id: 'f', walletId: e.getActiveWallet().id, name: 'd', handle: 'd', traderWallet: W, chainId: 'solana', status: 'copying', mode: 'buy-and-hold', sizing: { type: 'fixed', amount: 20 }, tpPct: null, slPct: null, minTradeUsd: 1, maxOpenPositions: 5, maxAtRiskUsd: 100, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {} });
  await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderHandle: 'd', traderWallet: W, traderBuyUsd: 50, token: { address: SOLANAGO, symbol: 'SolanaGO', isLaunchpad: true, marketCapUsd: 11000, traderFillPriceUsd: 0.000011, currentPriceUsd: 0.000011, safety: {} } });
  const pos = e.positions[0];
  assert.equal(pos.liquidityUsd, null, 'unknown liquidity stays unknown (no $25K placeholder)');
  assert.equal(pos.renounced, null, 'not claimed renounced without a check');
  const rpc = async (method, params) => {
    assert.equal(method, 'getMultipleAccounts');
    assert.deepEqual(params[0], ['GKxDmnD8NVwtf4S8MUk3tka68ydafuTG1LLqJepwb8M7']);
    return { value: [{ owner: PUMP_PROGRAM, data: [SOLANAGO_CURVE, 'base64'] }] };
  };
  e.curveSource = (mints) => fetchPumpCurves(rpc, mints, 105.59);
  e.priceFetch = async () => { throw new Error('DexScreener must not be needed for a live curve'); };
  await e.tickMarketPrices();
  assert.ok(Math.abs(pos.currentPriceUsd / 0.00001159 - 1) < 0.01);
  assert.ok(pos.liquidityUsd > 6000 && pos.liquidityUsd < 6400, `liquidity ${pos.liquidityUsd}`);
  assert.ok(Math.abs(pos.currentMarketCapUsd - 11591) < 150);
  assert.equal(pos.priceSource, 'pump-curve');
});

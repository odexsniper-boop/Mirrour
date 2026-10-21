/**
 * Live pump.fun bonding-curve data straight from the chain (no DexScreener delay).
 *
 * Every token still on its pump.fun curve has a "bonding-curve" account holding the pool's
 * reserves. Reading it gives the exact current price, market cap and the SOL really in the
 * pool. Graduated curves (`complete`) have moved to an AMM, where DexScreener is used instead.
 */
import { findProgramAddress, base58Decode } from './onchainMeta.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_DECIMALS = 6;
const curveCache = new Map(); // mint → PDA (derivation is pure; cache it)

export function bondingCurvePda(mint) {
  if (!curveCache.has(mint)) curveCache.set(mint, findProgramAddress([Buffer.from('bonding-curve'), base58Decode(mint)], PUMP_PROGRAM));
  return curveCache.get(mint);
}

/** Decode the BondingCurve account: 8-byte discriminator, five u64 fields, `complete` flag. */
export function parseBondingCurve(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  if (b.length < 8 + 8 * 5 + 1) return null;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  return {
    virtualTokenReserves: u64(8),
    virtualSolReserves: u64(16),
    realTokenReserves: u64(24),
    realSolReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: b[48] === 1,
  };
}

/** Price / market cap / liquidity in USD from curve reserves. */
export function curveMetrics(curve, solPriceUsd) {
  if (!curve || !(curve.virtualTokenReserves > 0) || !(solPriceUsd > 0)) return null;
  // A standard pump.fun curve always carries its 30 SOL of virtual reserves on top of the real
  // SOL. Curves that don't (other configs / migrated states) are not trusted: DexScreener is used.
  const virtualOnly = (curve.virtualSolReserves - curve.realSolReserves) / 1e9;
  if (virtualOnly < 25 || virtualOnly > 35) return null;
  const priceSol = curve.virtualSolReserves / 1e9 / (curve.virtualTokenReserves / 10 ** TOKEN_DECIMALS);
  const priceUsd = priceSol * solPriceUsd;
  const supply = curve.tokenTotalSupply / 10 ** TOKEN_DECIMALS;
  return {
    priceUsd,
    marketCapUsd: priceUsd * supply,
    // the SOL really deposited in the curve, counted on both sides of the pool (as DEX sites show it)
    liquidityUsd: (curve.realSolReserves / 1e9) * solPriceUsd * 2,
    complete: curve.complete,
    source: 'pump-curve',
  };
}

/**
 * Read many curves in one RPC call. Returns Map mint → metrics (only tokens still on a curve).
 * @param rpc async (method, params) => result
 */
export async function fetchPumpCurves(rpc, mints, solPriceUsd) {
  const out = new Map();
  const list = [...new Set(mints)].filter(Boolean).slice(0, 100);
  if (!list.length) return out;
  const pdas = list.map((m) => {
    try {
      return bondingCurvePda(m);
    } catch {
      return null;
    }
  });
  const valid = list.map((m, i) => [m, pdas[i]]).filter(([, p]) => p);
  const res = await rpc('getMultipleAccounts', [valid.map(([, p]) => p), { encoding: 'base64', commitment: 'confirmed' }]);
  (res?.value || []).forEach((acc, i) => {
    if (!acc || acc.owner !== PUMP_PROGRAM || !acc.data?.[0]) return;
    const m = curveMetrics(parseBondingCurve(acc.data[0]), solPriceUsd);
    if (m && !m.complete) out.set(valid[i][0], m);
  });
  return out;
}

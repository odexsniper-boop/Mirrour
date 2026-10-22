import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { CopyTradingEngine, createDefaultExitRules, recommendedExitRules, activeExitRuleCount, createDefaultUiSettings } from './engine/copyEngine.mjs';
import { CHAINS } from './engine/chainAdapters.mjs';
import { LiveSignalService } from './engine/liveSignals.mjs';
import { isSolanaAddress } from './engine/walletWatcher.mjs';
import { loadEnvFile, redact } from './engine/env.mjs';
import { AlchemyService } from './engine/alchemy.mjs';
import { OnchainMetadata } from './engine/onchainMeta.mjs';
import { fetchPumpCurves } from './engine/pumpCurve.mjs';
import { openDatabase } from './engine/db.mjs';
import { PersistenceManager, serializeEngine, serializeLive } from './engine/persistence.mjs';
import { SupabaseMirror, SUPABASE_TABLE_SQL, isSupabaseUrl } from './engine/supabase.mjs';
import fsSync from 'node:fs';
import { RealTrader } from './engine/realTrader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Local secrets (e.g. ALCHEMY_API_KEY) live in .env next to server.mjs — never in public/ files
const envFile = loadEnvFile(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3400);
// Hosting platforms (Railway) must reach the server from outside the container
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_PROJECT_ID);
// Only this computer can open the terminal unless ODEX_HOST says otherwise (Settings → Security)
const HOST = process.env.ODEX_HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
// Optional site password (HTTP Basic auth, any username). Set it on any public deploy.
const SITE_PASSWORD = process.env.ODEX_PASSWORD || '';
function passwordOk(req) {
  if (!SITE_PASSWORD) return true;
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(dec.slice(dec.indexOf(':') + 1));
  const want = Buffer.from(SITE_PASSWORD);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Alchemy: Solana RPC + token metadata/images. The key stays on the server.
export const alchemy = new AlchemyService({ apiKey: process.env.ALCHEMY_API_KEY });

export const engine = new CopyTradingEngine();
// Linked external wallets (public keys only — read-only, never used to sign)
if (!engine.settings.externalWallets) engine.settings.externalWallets = {};

// Connected SSE clients
const sseClients = new Set();

function broadcastRaw(obj) {
  const payload = JSON.stringify(obj);
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Live wallet watching (signals only — reads public chain data, never trades)
export const liveSignals = new LiveSignalService({ engine, broadcast: broadcastRaw, alchemy });
// Live pump.fun curve prices / liquidity for open positions (same RPC, rate-limited)
engine.curveSource = (mints) => fetchPumpCurves((m, p) => liveSignals.watcher.rpc(m, p), mints, CHAINS.solana.nativePriceUsd);
// Logos / wallet pictures straight from chain data when Alchemy DAS is down (same RPC as Live Signals)
alchemy.fallback = new OnchainMetadata({ rpc: (method, params) => liveSignals.watcher.rpc(method, params) });

// Database: SQLite (node:sqlite) or JSON fallback in ./data. Set ODEX_DB=off to run in-memory only.
export const db = process.env.ODEX_DB === 'off' ? null : await openDatabase({ dir: process.env.ODEX_DATA_DIR || path.join(__dirname, 'data') });
// Supabase cloud mirror (optional): SUPABASE_URL + SUPABASE_SERVICE_KEY in .env, server-side only
export const supabase = new SupabaseMirror({
  url: process.env.SUPABASE_URL || '',
  key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '',
  table: process.env.SUPABASE_TABLE || 'odex_kv',
});
export const persistence = db ? new PersistenceManager({ engine, live: liveSignals, store: db, cloud: supabase }) : null;
// Fresh install / empty local database: restore from Supabase first
if (persistence && supabase.enabled && !db.get('engine')) {
  try {
    const rows = await supabase.pullAll();
    if (rows.get('engine')) {
      db.setMany([...rows.entries()].filter(([k]) => k === 'engine' || k === 'liveSignals'));
      console.log('Database: restored from Supabase (local database was empty)');
    }
  } catch (err) {
    console.log(`Supabase: could not restore on startup (${err.message})`);
  }
}
if (persistence) {
  persistence.load();
  if (!engine.settings.externalWallets) engine.settings.externalWallets = {};
  persistence.attach();
}

// ---------- Real trading (Paper Trading OFF + ODEX_TRADER_KEY in .env) ----------
// The SOL price must be live before a real order is sized (never the built-in placeholder)
let solPriceLive = false;
export const realTrader = new RealTrader({
  env: process.env,
  rpc: (method, params) => liveSignals.watcher.rpc(method, params),
  solPrice: () => (solPriceLive ? CHAINS.solana.nativePriceUsd : 0),
  state: db ? db.get('realTrader') : null,
  onChange: () => {
    try {
      db?.set('realTrader', realTrader.exportState());
    } catch {
      // saving the trade log is best-effort
    }
  },
});
engine.adapter.liveHooks = realTrader.hooks();
// On a public deploy, real trading needs a site password (otherwise anyone with the link could trade)
const realBlockedReason = ON_RAILWAY && !SITE_PASSWORD ? 'public deploy without ODEX_PASSWORD: real trading is disabled' : null;
engine.adapter.realEnabled = () => realTrader.ready() && !realBlockedReason;
engine.realTradingActive = () => !engine.settings.paperTrading && engine.adapter.realEnabled();

// Real balance of the bot wallet → the engine's wallet balances (used for sizing and spend checks)
async function refreshRealBalance() {
  if (!realTrader.ready()) return null;
  try {
    const bal = await realTrader.refreshBalance();
    for (const w of engine.wallets) {
      if (w.archived) continue;
      if (!w.balances) w.balances = {};
      w.balances.solana = { native: bal.sol, stable: bal.usdc };
    }
    return bal;
  } catch {
    return null;
  }
}
setInterval(() => {
  if (engine.realTradingActive()) refreshRealBalance();
}, 15_000).unref?.();

engine.onUpdate((evt) => {
  broadcastRaw({
    event: evt.type,
    data: evt.payload,
    state: engine.getStateSnapshot(),
  });
  if (evt.type === 'follows_updated' || evt.type === 'state_reset') {
    liveSignals.sync();
  }
});

// Live 2-second price tick & exit evaluation loop
// Every manual change to a wallet's paper money is logged (newest 200), so the balance can
// always be reconciled: start + funding changes − buys + sells = balance.
function logPaperFunding(w, type, beforeUsd) {
  const before = Number(beforeUsd ?? 10000);
  const after = Number(w.paperBalanceUsd);
  if (!Array.isArray(w.paperLedger)) w.paperLedger = [];
  w.paperLedger.unshift({ t: Date.now(), type, beforeUsd: before, afterUsd: after, changeUsd: Number((after - before).toFixed(2)) });
  if (w.paperLedger.length > 200) w.paperLedger.length = 200;
}

let autoTickEnabled = true;
setInterval(async () => {
  if (!autoTickEnabled) return;
  await engine.tickMarketPrices();
}, 2000);

// Copies come only from real wallet swaps detected by the Live Signals watcher.

// Live SOL price (replaces the built-in placeholder price) — refreshed every minute
async function refreshSolPrice() {
  try {
    const px = await liveSignals.watcher.tokenInfo.solPriceUsd();
    if (Number(px) > 0 && px !== liveSignals.watcher.tokenInfo.fallbackSolPriceUsd) {
      CHAINS.solana.nativePriceUsd = Number(Number(px).toFixed(2));
      solPriceLive = true;
    }
  } catch {
    // keep the last known price
  }
}
refreshSolPrice();
setInterval(refreshSolPrice, 60_000).unref?.();

// Event-loop lag sampler for the health check
{
  let expected = Date.now() + 1000;
  setInterval(() => {
    const now = Date.now();
    globalThis.__odexLagMs = Math.max(0, now - expected);
    expected = now + 1000;
  }, 1000).unref?.();
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Update KEY=value lines in the .env file (null removes the key); other lines are kept. */
function setEnvValues(values) {
  const file = path.join(__dirname, '.env');
  let lines = [];
  try {
    lines = fsSync.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  for (const [k, v] of Object.entries(values)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    if (v === null || v === undefined || v === '') {
      if (idx >= 0) lines.splice(idx, 1);
      delete process.env[k];
    } else {
      const line = `${k}=${v}`;
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
      process.env[k] = v;
    }
  }
  fsSync.writeFileSync(file, `${lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n').trim()}\n`);
}

function isAllowedHost(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true; // non-browser clients
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  const extra = String(process.env.ODEX_ALLOWED_HOSTS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) extra.push(String(process.env.RAILWAY_PUBLIC_DOMAIN).toLowerCase());
  return extra.includes(host);
}
function requestBlockedReason(req) {
  if (!isAllowedHost(req.headers.host)) return 'Blocked: unknown host name (set ODEX_ALLOWED_HOSTS to allow it).';
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'Blocked: requests from other websites are not allowed.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return 'Blocked: requests from other websites are not allowed.';
    } catch {
      return 'Blocked: bad origin.';
    }
  } else if (origin === 'null') return 'Blocked: requests from other websites are not allowed.';
  return null;
}

async function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        err.statusCode = 400;
        err.message = `Invalid JSON body: ${err.message}`;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

export const server = http.createServer(async (req, res) => {
  if (!passwordOk(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Odex Mirror", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Password required');
  }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Request guard: this server can spend real SOL, so only this app may drive it.
    //  - Host must be this machine / an IP (blocks DNS-rebinding sites)
    //  - changes (non-GET) must come from this app's own page, never from another website
    if (pathname.startsWith('/api/')) {
      const blocked = requestBlockedReason(req);
      if (blocked) return sendJson(res, 403, { ok: false, error: blocked });
    }

    // 1. Server-Sent Events stream for real-time terminal updates
    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ event: 'connected', state: engine.getStateSnapshot() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 2. Full Engine State Snapshot
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        ok: true,
        autoTickEnabled,
        state: engine.getStateSnapshot(),
      });
    }

    // Website health check (bug checker): every server subsystem reports ok / problem
    if (req.method === 'GET' && pathname === '/api/health') {
      const now = Date.now();
      const checks = [];
      const add = (id, name, ok, detail, severity = 'error') => checks.push({ id, name, ok: Boolean(ok), detail: ok ? null : detail, severity });

      // Database
      if (persistence) {
        const pi = persistence.info();
        add('db', 'Database saving', !pi.lastError, pi.lastError || '');
      } else add('db', 'Database saving', true, '');

      // Solana RPC
      try {
        const t0 = Date.now();
        await liveSignals.watcher.rpc('getSlot', [{ commitment: 'processed' }]);
        const ms = Date.now() - t0;
        add('rpc', 'Solana connection', ms < 5000, `Solana RPC is very slow (${ms} ms)`, 'warning');
      } catch (err) {
        add('rpc', 'Solana connection', false, redact(`Solana RPC not reachable: ${err.message}`, alchemy.apiKey));
      }

      // Wallet watcher
      const ws = liveSignals.watcher.getStatus();
      const watchList = liveSignals.watchList();
      const enabled = liveSignals.config.enabled;
      const intervalMs = liveSignals.config.pollSec * 1000;
      if (enabled && watchList.length) {
        add('watcher-running', 'Wallet watcher running', ws.running, 'Watching is on but the watcher is not running');
        const stalled = ws.running && ws.lastSuccessAt && now - ws.lastSuccessAt > Math.max(90_000, intervalMs * 6);
        add('watcher-stalled', 'Wallet watcher up to date', !stalled, `No successful check for ${Math.round((now - (ws.lastSuccessAt || now)) / 1000)} s`);
        add('watcher-errors', 'Wallet watcher errors', !ws.lastError, redact(ws.lastError || '', alchemy.apiKey));
        const sm = ws.stream || {};
        if (sm.enabled && ws.running) {
          // Down for over a minute = slower copies (backup checks still find every trade)
          const down = !sm.connected && sm.downSince && now - sm.downSince > 60_000;
          add('stream', 'Real-time stream', !down, `Real-time stream not connected${sm.lastError ? `: ${redact(sm.lastError, alchemy.apiKey)}` : ''}. Trades are still found by the ${liveSignals.config.pollSec}s backup check.`, 'warning');
        }
        for (const w of ws.wallets || []) {
          if (w.error) add(`wallet-${w.address}`, `Reading wallet ${w.label || w.address.slice(0, 6)}`, false, redact(w.error, alchemy.apiKey), 'warning');
          // a slow backup check is fine; one stuck for minutes is not
          else if (w.slowSince && now - w.slowSince > 120_000) add(`wallet-${w.address}`, `Reading wallet ${w.label || w.address.slice(0, 6)}`, false, `Backup check still running after ${Math.round((now - w.slowSince) / 1000)} s (wallet is flooded with spam). Real-time copies are not affected.`, 'warning');
        }
      } else {
        add('watcher-off', 'Wallet watching', !(liveSignals.config.paperCopy && engine.follows.some((f) => f.status === 'copying') && !enabled), 'Watching is switched off, so followed wallets are not being copied', 'warning');
      }

      // Alchemy + price feed
      if (alchemy.enabled) {
        const a = alchemy.status();
        // One-off busy errors (429/503) are retried and normal; flag only repeated failures with no success since
        const dasBad = a.lastErrorAt && (!a.lastOkAt || a.lastErrorAt > a.lastOkAt) && now - a.lastErrorAt < 300_000 && (a.consecutiveFailures || 0) >= 3;
        const fb = a.fallback;
        const fallbackOk = fb && (!fb.lastErrorAt || (fb.lastOkAt && fb.lastOkAt >= fb.lastErrorAt));
        if (a.das?.down || dasBad) {
          // Alchemy's DAS API is down: fine as long as the on-chain fallback is delivering logos
          add('alchemy', 'Token logos & metadata', Boolean(fallbackOk), fallbackOk ? '' : `Alchemy DAS unavailable (${a.das?.lastError || a.lastError}) and the on-chain fallback is failing too: ${fb?.lastError || 'unknown error'}`, 'warning');
        } else {
          add('alchemy', 'Token logos & metadata', true, '', 'warning');
        }
      }
      const pf = engine.priceFeed || {};
      const priceBad = pf.lastError && (!pf.lastOkAt || pf.lastErrorAt > pf.lastOkAt) && now - pf.lastErrorAt < 120_000;
      add('prices', 'Live price feed', !priceBad, pf.lastError || '', 'warning');

      // Supabase cloud backup
      if (supabase.enabled) {
        const sb = supabase.status();
        const bad = sb.lastError && (!sb.lastSyncAt || sb.lastErrorAt > sb.lastSyncAt);
        add('supabase', 'Supabase cloud backup', !bad, sb.lastError || '', 'warning');
      }

      // Server load (event-loop lag)
      const lag = globalThis.__odexLagMs || 0;
      add('lag', 'Server responsiveness', lag < 1000, `Server is overloaded (event loop ${lag} ms behind)`, 'warning');

      // Data sanity
      const badPos = engine.positions.filter((p) => p.remainingTokens > 0 && !(Number(p.currentPriceUsd) > 0 && Number.isFinite(Number(p.currentPriceUsd))));
      add('positions', 'Position prices', !badPos.length, `${badPos.length} open position(s) without a valid price: ${badPos.map((p) => p.symbol).slice(0, 4).join(', ')}`, 'warning');
      // Real trading
      if (!engine.settings.paperTrading) {
        const rs = realTrader.status();
        add('real-key', 'Real trading wallet', rs.ready, rs.keyError || 'Paper Trading is OFF but no bot wallet key is set (ODEX_TRADER_KEY in .env), so nothing is copied');
        add('real-price', 'Live SOL price for real orders', solPriceLive, 'SOL price not loaded yet — real orders wait for it', 'warning');
        const recentErr = rs.lastError && now - rs.lastError.at < 600_000;
        add('real-errors', 'Real orders', !recentErr, recentErr ? redact(rs.lastError.error, alchemy.apiKey) : '', 'warning');
        if (rs.ready && rs.balance) add('real-gas', 'Bot wallet SOL for fees', rs.balance.sol >= rs.caps.reserveSol, `Only ${rs.balance.sol.toFixed(4)} SOL in the bot wallet — keep at least ${rs.caps.reserveSol} SOL for fees`, 'warning');
      }
      const badWallet = engine.wallets.find((w) => !Number.isFinite(Number(w.paperBalanceUsd ?? 0)) || Number(w.paperBalanceUsd ?? 0) < 0);
      add('balances', 'Wallet balances', !badWallet, `Invalid paper balance on wallet ${badWallet?.name}`);

      return sendJson(res, 200, { ok: checks.every((c) => c.ok), checkedAt: now, checks });
    }

    // Real trading: status (never includes the key) and a safe self-test that sends nothing
    if (req.method === 'GET' && pathname === '/api/real/status') {
      if (engine.realTradingActive()) await refreshRealBalance();
      return sendJson(res, 200, { ok: true, active: engine.realTradingActive(), paperTrading: engine.settings.paperTrading, solPriceLive, ...realTrader.status() });
    }
    if (req.method === 'POST' && pathname === '/api/real/test') {
      const r = await realTrader.selfTest();
      return sendJson(res, 200, { ...r, steps: (r.steps || []).map((s) => redact(s, alchemy.apiKey)), error: r.error ? redact(r.error, alchemy.apiKey) : null });
    }

    // Live ping: round-trip time to the Solana RPC (cached a few seconds)
    if (req.method === 'GET' && pathname === '/api/ping') {
      const now = Date.now();
      if (!globalThis.__odexPing || now - globalThis.__odexPing.at > 4000) {
        const t0 = Date.now();
        try {
          await liveSignals.watcher.rpc('getSlot', [{ commitment: 'processed' }]);
          globalThis.__odexPing = { at: now, rpcMs: Date.now() - t0, ok: true };
        } catch (err) {
          globalThis.__odexPing = { at: now, rpcMs: null, ok: false, error: redact(err.message, alchemy.apiKey) };
        }
      }
      return sendJson(res, 200, { ok: true, provider: liveSignals.rpcProvider(), ...globalThis.__odexPing });
    }

    // 3. Trader wallet check: is this wallet actually swapping on-chain? (read-only)
    if (req.method === 'GET' && pathname === '/api/traders/check') {
      const address = String(url.searchParams.get('address') || '').trim();
      if (!isSolanaAddress(address)) return sendJson(res, 400, { ok: false, error: 'Enter a valid Solana wallet address.' });
      try {
        const report = await liveSignals.watcher.checkWallet(address, { limit: Number(url.searchParams.get('limit')) || 25 });
        return sendJson(res, 200, { ok: true, ...report });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: redact(`Could not read this wallet: ${err.message}`, alchemy.apiKey) });
      }
    }

    // 5. Copy a trader by wallet address (Solana — the chain the live watcher reads)
    if (req.method === 'POST' && pathname === '/api/follows') {
      const body = await readJsonBody(req);
      const activeWallet = engine.getActiveWallet();
      const traderWallet = String(body.traderWallet || body.solanaWallet || '').trim();
      if (!isSolanaAddress(traderWallet)) {
        return sendJson(res, 400, { ok: false, error: 'Paste the trader\'s Solana wallet address.' });
      }
      const nameRaw = String(body.name || '').trim();
      if (nameRaw.length > 32) return sendJson(res, 400, { ok: false, error: 'Name cannot exceed 32 characters.' });
      if (engine.follows.some((f) => f.walletId === activeWallet.id && f.chainId === 'solana' && f.traderWallet === traderWallet)) {
        return sendJson(res, 409, { ok: false, error: 'You are already copying this wallet.' });
      }
      const MODES = ['auto-exit', 'buy-and-hold', 'mirror'];
      const SIZING = ['fixed', 'percent', 'proportional'];
      const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      const sizingType = SIZING.includes(body.sizing?.type) ? body.sizing.type : 'fixed';
      const sizingAmount = num(body.sizing?.amount) ?? 50;
      if (sizingAmount <= 0) return sendJson(res, 400, { ok: false, error: 'Size must be greater than zero.' });
      if (sizingType === 'percent' && sizingAmount > 100) return sendJson(res, 400, { ok: false, error: '% of balance cannot exceed 100.' });
      const tpPct = num(body.tpPct);
      const slPct = num(body.slPct);
      if (tpPct !== null && tpPct <= 0) return sendJson(res, 400, { ok: false, error: 'Take profit must be above 0%.' });
      if (slPct !== null && (slPct <= 0 || slPct >= 100)) return sendJson(res, 400, { ok: false, error: 'Stop loss must be between 0% and 100%.' });
      const short = `${traderWallet.slice(0, 4)}…${traderWallet.slice(-4)}`;
      const follow = {
        id: `fol-${randomUUID().slice(0, 8)}`,
        walletId: activeWallet.id,
        name: nameRaw || short,
        handle: (nameRaw || short).replace(/^@/, ''),
        traderWallet,
        chainId: 'solana',
        status: 'copying',
        pauseReason: null,
        mode: MODES.includes(body.mode) ? body.mode : 'auto-exit',
        sizing: { type: sizingType, amount: Math.min(sizingType === 'percent' ? 100 : 100000, sizingAmount) },
        tpPct,
        slPct,
        minTradeUsd: num(body.minTradeUsd) ?? 1,
        maxOpenPositions: num(body.maxOpenPositions) ?? 10,
        maxAtRiskUsd: num(body.maxAtRiskUsd) ?? 1000,
        consecutiveLosses: 0,
        // Auto-Exit with zero rules would never sell on its own → start with the recommended five
        exitRules:
          body.exitRules
            ? createDefaultExitRules(body.exitRules)
            : (MODES.includes(body.mode) ? body.mode : 'auto-exit') === 'auto-exit'
              ? recommendedExitRules()
              : createDefaultExitRules(),
        filtersOverride: { pumpOnly: null, minMarketCapUsd: null, maxMarketCapUsd: null, minTraderBuyNative: null, maxTraderBuyNative: null, stage: null },
        createdAt: Date.now(),
      };
      engine.follows.unshift(follow);
      engine.emit('follows_updated', { created: [follow] });
      return sendJson(res, 200, { ok: true, created: [follow], state: engine.getStateSnapshot() });
    }

    // 6. Update / Pause / Resume / Edit / Delete a Follow
    if (pathname.startsWith('/api/follows/')) {
      const followId = pathname.split('/')[3];
      const action = pathname.split('/')[4];

      if (req.method === 'POST' && followId === 'pause-all') {
        for (const f of engine.follows) {
          f.status = 'paused';
          f.pauseReason = 'manual';
        }
        engine.emit('follows_updated', {});
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && followId === 'resume-all') {
        for (const f of engine.follows) {
          f.status = 'copying';
          f.pauseReason = null;
          f.consecutiveLosses = 0;
        }
        engine.emit('follows_updated', {});
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      const follow = engine.follows.find((f) => f.id === followId);
      if (!follow) return sendJson(res, 404, { ok: false, error: 'Follow not found.' });

      if (req.method === 'DELETE') {
        engine.follows = engine.follows.filter((f) => f.id !== followId);
        engine.emit('follows_updated', { removedId: followId });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      if (req.method === 'PATCH' || (req.method === 'POST' && action === 'update')) {
        const body = await readJsonBody(req);
        const FOLLOW_MODES = ['auto-exit', 'buy-and-hold', 'mirror'];
        const SIZING_TYPES = ['fixed', 'percent', 'proportional'];
        if (body.status !== undefined && !['copying', 'paused'].includes(body.status)) return sendJson(res, 400, { ok: false, error: 'Status must be copying or paused.' });
        if (body.mode !== undefined && !FOLLOW_MODES.includes(body.mode)) return sendJson(res, 400, { ok: false, error: 'Unknown copy mode.' });
        if (body.sizing) {
          const t = body.sizing.type ?? follow.sizing.type;
          const a = Number(body.sizing.amount ?? follow.sizing.amount);
          if (!SIZING_TYPES.includes(t)) return sendJson(res, 400, { ok: false, error: 'Unknown sizing type.' });
          if (!(a > 0) || (t === 'percent' && a > 100)) return sendJson(res, 400, { ok: false, error: t === 'percent' ? '% of balance must be between 0 and 100.' : 'Size must be greater than zero.' });
        }
        for (const [k, lo, hi] of [['tpPct', 0, 100000], ['slPct', 0, 100], ['minTradeUsd', -1, 1e9], ['maxOpenPositions', 0, 10000], ['maxAtRiskUsd', 0, 1e9]]) {
          const v = body[k];
          if (v === undefined || v === null || v === '') continue;
          if (!Number.isFinite(Number(v)) || Number(v) <= lo || Number(v) > hi) return sendJson(res, 400, { ok: false, error: `Invalid value for ${k}.` });
        }
        if (body.status) {
          follow.status = body.status;
          if (body.status === 'copying') {
            follow.pauseReason = null;
            follow.consecutiveLosses = 0;
          }
        }
        if (body.name !== undefined) {
          const clean = String(body.name).trim();
          if (clean.length > 32) {
            return sendJson(res, 400, { ok: false, error: 'Name must be 32 characters or fewer.' });
          }
          follow.name = clean === '-' || !clean ? follow.handle : clean;
        }
        if (body.mode) {
          follow.mode = body.mode;
          if (body.mode === 'auto-exit' && !body.exitRules && activeExitRuleCount(follow.exitRules) === 0) follow.exitRules = recommendedExitRules();
        }
        if (body.useRecommendedExits) follow.exitRules = recommendedExitRules();
        if (body.sizing) {
          follow.sizing = {
            type: body.sizing.type || follow.sizing.type,
            amount: Number(body.sizing.amount ?? follow.sizing.amount),
          };
        }
        if (body.tpPct !== undefined) follow.tpPct = body.tpPct === null || body.tpPct === '' ? null : Number(body.tpPct);
        if (body.slPct !== undefined) follow.slPct = body.slPct === null || body.slPct === '' ? null : Number(body.slPct);
        for (const k of ['minTradeUsd', 'maxOpenPositions', 'maxAtRiskUsd']) {
          if (body[k] !== undefined) follow[k] = body[k] === null || body[k] === '' ? null : Number(body[k]);
        }
        if (body.exitRules) {
          follow.exitRules = createDefaultExitRules({
            takeInitials: { ...follow.exitRules.takeInitials, ...(body.exitRules.takeInitials || {}) },
            moonbagTrail: { ...follow.exitRules.moonbagTrail, ...(body.exitRules.moonbagTrail || {}) },
            floor: { ...follow.exitRules.floor, ...(body.exitRules.floor || {}) },
            waveCut: { ...follow.exitRules.waveCut, ...(body.exitRules.waveCut || {}) },
            hardTimeCap: { ...follow.exitRules.hardTimeCap, ...(body.exitRules.hardTimeCap || {}) },
          });
        }
        if (body.filtersOverride) {
          follow.filtersOverride = {
            ...follow.filtersOverride,
            ...body.filtersOverride,
          };
        }
        engine.emit('follows_updated', { follow });
        return sendJson(res, 200, { ok: true, follow, state: engine.getStateSnapshot() });
      }
    }

    // 7. Positions: Sell, Sell Initials, Sell All, Panic Sell, Arm/Cancel Limit Orders, Price Override
    if (pathname === '/api/positions/sell-all' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await engine.sellAllPositions({
        chainId: body.chainId || 'all',
        panic: Boolean(body.panic),
      });
      return sendJson(res, 200, { ...result, state: engine.getStateSnapshot() });
    }

    if (pathname.startsWith('/api/positions/')) {
      const parts = pathname.split('/');
      const posId = parts[3];
      const subAction = parts[4];
      const body = req.method !== 'GET' ? await readJsonBody(req) : {};

      if (req.method === 'POST' && subAction === 'sell') {
        if (body.mode === 'initials') {
          const resSell = await engine.sellInitialsManual(posId);
          return sendJson(res, resSell.ok ? 200 : 400, { ...resSell, state: engine.getStateSnapshot() });
        }
        const resSell = await engine.executePositionSell(posId, {
          sellPct: Number(body.sellPct || 100),
          cause: 'manual sell',
        });
        return sendJson(res, resSell.ok ? 200 : 400, { ...resSell, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && subAction === 'limit-orders') {
        const resOrd = engine.armLimitOrder(posId, body);
        return sendJson(res, resOrd.ok ? 200 : 400, { ...resOrd, state: engine.getStateSnapshot() });
      }

      if (req.method === 'DELETE' && subAction === 'limit-orders') {
        const orderId = parts[5] || body.orderId;
        const resCancel = engine.cancelLimitOrder(posId, orderId);
        return sendJson(res, resCancel.ok ? 200 : 400, { ...resCancel, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && subAction === 'nudge-price') {
        const pos = engine.positions.find((p) => p.id === posId && p.remainingTokens > 0);
        if (!pos) return sendJson(res, 404, { ok: false, error: 'Position not found' });
        const mult = Number(body.multiplier || 1.25);
        await engine.tickMarketPrices({ [posId]: mult });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }
    }

    // 8. Account Settings, Filters, Safety & Risk Limits
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.ui && typeof body.ui === 'object') {
        // Profile / security / notification preferences: validated field by field
        const u = { ...createDefaultUiSettings(), ...(engine.settings.ui || {}) };
        const b = body.ui;
        if (b.displayName !== undefined) u.displayName = String(b.displayName || '').replace(/[<>]/g, '').trim().slice(0, 32);
        if (['local', 'utc'].includes(b.timeZone)) u.timeZone = b.timeZone;
        if (['positions', 'closed', 'signals'].includes(b.landingTab)) u.landingTab = b.landingTab;
        if (typeof b.confirmSells === 'boolean') u.confirmSells = b.confirmSells;
        if (typeof b.hideBalances === 'boolean') u.hideBalances = b.hideBalances;
        if (b.notify && typeof b.notify === 'object') {
          u.notify = { ...u.notify };
          for (const k of ['copies', 'sells', 'skips', 'problems', 'sound']) if (typeof b.notify[k] === 'boolean') u.notify[k] = b.notify[k];
        }
        engine.settings.ui = u;
        engine.emit('settings_updated', { ui: true });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }
      if (body.reset) {
        const keepTradingAsset = { ...engine.settings.tradingAsset };
        engine.settings.buySlippagePct = { solana: 15, evm: null };
        engine.settings.sellSlippagePct = null;
        engine.settings.priorityFee = { mode: 'normal', customSol: 0.002 };
        engine.settings.cooldown = { enabled: true, mode: 'duration', durationSec: 600 };
        engine.settings.retryBuys = true;
        engine.settings.maxChasePct = 25;
        engine.settings.filters = {
          pumpOnly: body.keepPumpOnly ? engine.settings.filters.pumpOnly : false,
          minMarketCapUsd: null,
          maxMarketCapUsd: null,
          minTraderBuyNative: null,
          maxTraderBuyNative: null,
          stage: 'any',
        };
        engine.settings.safety = {
          blockRiskyCoins: true,
          blockMintableSupply: false,
          strictNonPump: false,
        };
        engine.settings.risk = {
          dailyLossLimitUsd: null,
          dailyLossTriggered: false,
          streakLimit: null,
          exposureLimitUsd: null,
        };
        engine.settings.tradingAsset = keepTradingAsset;
        engine.settings.paperTrading = true;
      } else {
        if (body.paperTrading !== undefined) {
          engine.settings.paperTrading = Boolean(body.paperTrading);
          // real trading just switched on: load the bot wallet's balance before the next copy
          if (!engine.settings.paperTrading) await refreshRealBalance();
        }
        const clampPct = (v, lo, hi) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Math.min(hi, Math.max(lo, Number(v))));
        if (body.buySlippagePct) {
          const next = { ...engine.settings.buySlippagePct };
          for (const k of ['solana', 'evm']) if (k in body.buySlippagePct) next[k] = clampPct(body.buySlippagePct[k], 0.1, 50);
          if (next.solana === null) next.solana = 15;
          engine.settings.buySlippagePct = next;
        }
        if (body.sellSlippagePct !== undefined) {
          engine.settings.sellSlippagePct = clampPct(body.sellSlippagePct, 0.1, 50);
        }
        if (body.maxChasePct !== undefined) {
          engine.settings.maxChasePct = Math.min(1000, Math.max(1, Number(body.maxChasePct)));
        }
        if (body.priorityFee) {
          engine.settings.priorityFee = { ...engine.settings.priorityFee, ...body.priorityFee };
        }
        if (body.tradingAsset) {
          engine.settings.tradingAsset = { ...engine.settings.tradingAsset, ...body.tradingAsset };
        }
        if (body.cooldown) {
          engine.settings.cooldown = { ...engine.settings.cooldown, ...body.cooldown };
        }
        if (body.retryBuys !== undefined) {
          engine.settings.retryBuys = Boolean(body.retryBuys);
        }
        if (body.muteWarnings !== undefined) {
          engine.settings.muteWarnings = Boolean(body.muteWarnings);
        }
        if (body.filters) {
          engine.settings.filters = { ...engine.settings.filters, ...body.filters };
        }
        if (body.safety) {
          engine.settings.safety = { ...engine.settings.safety, ...body.safety };
        }
        if (body.risk) {
          engine.settings.risk = { ...engine.settings.risk, ...body.risk };
        }
      }
      engine.emit('settings_updated', engine.settings);
      return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
    }

    // 9. Wallets, Deposit, Withdraw, Bridge, Security
    if (pathname === '/api/wallets' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = body.action;

      if (action === 'create') {
        const activeWallets = engine.wallets.filter((w) => !w.archived);
        if (activeWallets.length >= 5) {
          return sendJson(res, 400, { ok: false, error: 'Maximum of 5 active wallets reached.' });
        }
        const idx = engine.wallets.length + 1;
        const newWallet = {
          id: `w-${randomUUID().slice(0, 6)}`,
          index: idx,
          name: body.name || `Wallet ${idx}`,
          active: false,
          archived: false,
          // No made-up addresses: a wallet only gets a deposit address that its owner provides
          solanaAddress: '',
          evmAddress: '',
          exportedSolana: false,
          exportedEvm: false,
          balances: {
            solana: { native: 0, stable: 0 },
            bsc: { native: 0, stable: 0 },
            robinhood: { native: 0, stable: 0 },
            arc: { native: 0, stable: 0 },
          },
          paperBalanceUsd: 10000,
        };
        engine.wallets.push(newWallet);
      } else if (action === 'switch') {
        for (const w of engine.wallets) {
          w.active = w.id === body.walletId;
        }
      } else if (action === 'rename') {
        const w = engine.getWalletById(body.walletId);
        if (w && body.name) w.name = String(body.name).trim().slice(0, 24);
      } else if (action === 'delete') {
        // Remove a wallet. The default wallet stays; a wallet with open positions must sell first.
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived);
        if (!w) return sendJson(res, 404, { ok: false, error: 'Wallet not found.' });
        const def = engine.getDefaultWallet();
        if (w.id === def?.id) return sendJson(res, 400, { ok: false, error: "The default wallet can't be deleted. Make another wallet the default first." });
        const open = engine.positions.filter((p) => p.walletId === w.id && p.remainingTokens > 0).length;
        if (open) return sendJson(res, 400, { ok: false, error: `This wallet still has ${open} open position${open === 1 ? '' : 's'}. Sell ${open === 1 ? 'it' : 'them'} first.` });
        for (const f of engine.follows) if (f.walletId === w.id) f.walletId = def.id; // its copytrades move to the default wallet
        if (w.active) for (const x of engine.wallets) x.active = x.id === def.id;
        engine.wallets = engine.wallets.filter((x) => x.id !== w.id); // trade history keeps the wallet's name
      } else if (action === 'set-default') {
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived);
        if (!w) return sendJson(res, 404, { ok: false, error: 'Wallet not found.' });
        for (const x of engine.wallets) x.isDefault = x.id === w.id;
      } else if (action === 'set-paper-balance') {
        // Set a wallet's paper money to an exact amount, in USD or SOL (at the live SOL price)
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived) || engine.getActiveWallet();
        const unit = body.unit === 'sol' ? 'sol' : 'usd';
        const amount = Number(body.amount);
        const px = Number(CHAINS.solana.nativePriceUsd) || 0;
        if (unit === 'sol' && !(px > 0)) return sendJson(res, 400, { ok: false, error: 'SOL price not known yet. Try again in a moment or enter USD.' });
        const usd = unit === 'sol' ? amount * px : amount;
        if (!(Number.isFinite(usd) && usd >= 0 && usd <= 1_000_000)) return sendJson(res, 400, { ok: false, error: 'Enter an amount between $0 and $1,000,000.' });
        const before = w.paperBalanceUsd;
        w.paperBalanceUsd = Number(usd.toFixed(2));
        logPaperFunding(w, 'set', before);
      } else if (action === 'archive') {
        const w = engine.getWalletById(body.walletId);
        if (w && !w.active) w.archived = true;
      } else if (['deposit', 'bridge', 'withdraw', 'set-withdrawal-address', 'toggle-address-cooldown'].includes(action)) {
        // Odex Mirror never moves real money; these simulated money actions were removed
        return sendJson(res, 410, { ok: false, error: 'Moving funds is not supported. Deposit with Phantom or the QR code; paper money uses "paper-funds".' });
      } else if (action === 'link-external') {
        const provider = String(body.provider || 'phantom');
        const address = String(body.address || '').trim();
        if (provider !== 'phantom') return sendJson(res, 400, { ok: false, error: 'Only Phantom linking is supported.' });
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          return sendJson(res, 400, { ok: false, error: 'Phantom returned an invalid Solana address.' });
        }
        engine.settings.externalWallets = engine.settings.externalWallets || {};
        engine.settings.externalWallets.phantom = { address, linkedAt: Date.now() };
      } else if (action === 'paper-funds') {
        // Paper trading money (USD) — what paper copies spend; never real funds
        const w = engine.getWalletById(body.walletId) || engine.getActiveWallet();
        const amount = Number(body.amountUsd);
        const before = w.paperBalanceUsd;
        if (body.reset) w.paperBalanceUsd = 10000;
        else {
          if (!(amount > 0 && amount <= 1_000_000)) return sendJson(res, 400, { ok: false, error: 'Enter an amount between $1 and $1,000,000.' });
          w.paperBalanceUsd = Number(((w.paperBalanceUsd ?? 10000) + amount).toFixed(2));
        }
        logPaperFunding(w, body.reset ? 'reset' : 'top-up', before);
      } else if (action === 'set-solana-address') {
        const w = engine.getWalletById(body.walletId) || engine.getActiveWallet();
        const address = String(body.address || '').trim();
        if (address && !isSolanaAddress(address)) return sendJson(res, 400, { ok: false, error: 'That is not a valid Solana address.' });
        w.solanaAddress = address;
      } else if (action === 'unlink-external') {
        if (engine.settings.externalWallets) delete engine.settings.externalWallets.phantom;
      }

      engine.emit('wallets_updated', {});
      return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
    }

    // 9.3 Database status, manual save, backup export / import
    if (pathname === '/api/db' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, enabled: Boolean(persistence), ...(persistence ? persistence.info() : {}) });
    }
    if (pathname === '/api/db/save' && req.method === 'POST') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off (ODEX_DB=off).' });
      const ok = persistence.saveNow();
      return sendJson(res, ok ? 200 : 500, { ok, ...persistence.info() });
    }
    if (pathname === '/api/db/export' && req.method === 'GET') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="odex-mirror-backup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(persistence.exportBackup(), null, 2));
    }
    if (pathname === '/api/db/import' && req.method === 'POST') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      try {
        const backup = await readJsonBody(req, 25_000_000);
        const restored = persistence.importBackup(backup);
        liveSignals.sync();
        engine.emit('state_restored', restored);
        return sendJson(res, 200, { ok: true, restored, state: engine.getStateSnapshot() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // 9.33 PnL calendar: realized PnL per day for a month
    if (pathname === '/api/pnl/calendar' && req.method === 'GET') {
      const now = new Date();
      const year = Number(url.searchParams.get('year')) || now.getUTCFullYear();
      const month = Number(url.searchParams.get('month')) || now.getUTCMonth() + 1;
      const tz = Number(url.searchParams.get('tz')) || 0;
      if (month < 1 || month > 12 || year < 2000 || year > 2100 || Math.abs(tz) > 900) return sendJson(res, 400, { ok: false, error: 'Bad month or time zone.' });
      return sendJson(res, 200, { ok: true, ...engine.pnlCalendar({ year, month, tzOffsetMin: tz, paper: url.searchParams.get('mode') !== 'real' }) });
    }

    // 9.34 Security: who can reach this server, where keys live
    if (pathname === '/api/security' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        host: HOST,
        lanAccess: HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1',
        pendingLanAccess: process.env.ODEX_HOST ? !['127.0.0.1', 'localhost', '::1'].includes(process.env.ODEX_HOST) : false,
        port: PORT,
        alchemy: { configured: alchemy.enabled, keyMasked: alchemy.enabled ? alchemy.status().keyMasked : null },
        supabase: { configured: supabase.enabled, keyMasked: supabase.enabled ? supabase.status().keyMasked : null, host: supabase.status().host },
        phantom: engine.settings.externalWallets?.phantom?.address || null,
        devTools: process.env.ODEX_DEV_TOOLS === '1',
      });
    }
    if (pathname === '/api/security' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.lanAccess !== 'boolean') return sendJson(res, 400, { ok: false, error: 'lanAccess must be true or false.' });
      try {
        setEnvValues({ ODEX_HOST: body.lanAccess ? '0.0.0.0' : null });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `Could not save .env: ${err.message}` });
      }
      return sendJson(res, 200, { ok: true, restartNeeded: true, pendingLanAccess: body.lanAccess });
    }

    // 9.35 Supabase cloud backup (keys stay in .env on this server; only a masked key is ever returned)
    if (pathname === '/api/db/supabase' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...supabase.status(), sql: SUPABASE_TABLE_SQL });
    }
    if (pathname === '/api/db/supabase' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const sbUrl = String(body.url || '').trim().replace(/\/+$/, '');
      const sbKey = String(body.key || '').trim();
      const table = String(body.table || 'odex_kv').trim();
      if (!isSupabaseUrl(sbUrl)) return sendJson(res, 400, { ok: false, error: 'Enter your Supabase project URL (https://xxxx.supabase.co).' });
      if (sbKey.length < 20) return sendJson(res, 400, { ok: false, error: 'Paste the service role key from Supabase → Project settings → API.' });
      const trial = new SupabaseMirror({ url: sbUrl, key: sbKey, table });
      const t = await trial.test();
      if (!t.ok) return sendJson(res, 400, { ok: false, error: t.error, tableMissing: Boolean(t.tableMissing), sql: SUPABASE_TABLE_SQL });
      try {
        setEnvValues({ SUPABASE_URL: sbUrl, SUPABASE_SERVICE_KEY: sbKey, SUPABASE_TABLE: trial.table === 'odex_kv' ? null : trial.table });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `Connected, but could not save .env: ${err.message}` });
      }
      supabase.configure({ url: sbUrl, key: sbKey, table: trial.table });
      let pushed = false;
      if (persistence) {
        try {
          const entries = [['engine', serializeEngine(engine)], ['liveSignals', serializeLive(liveSignals)]];
          pushed = await supabase.push(entries);
        } catch {
          pushed = false;
        }
      }
      return sendJson(res, 200, { ok: true, pushed, ...supabase.status() });
    }
    if (pathname === '/api/db/supabase/sync' && req.method === 'POST') {
      if (!supabase.enabled) return sendJson(res, 400, { ok: false, error: 'Supabase is not connected.', ...supabase.status() });
      try {
        await supabase.push([['engine', serializeEngine(engine)], ['liveSignals', serializeLive(liveSignals)]]);
        return sendJson(res, 200, { ok: true, ...supabase.status() });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, ...supabase.status() });
      }
    }
    if (pathname === '/api/db/supabase/restore' && req.method === 'POST') {
      if (!supabase.enabled) return sendJson(res, 400, { ok: false, error: 'Supabase is not connected.' });
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      try {
        const restored = persistence.restoreFromRows(await supabase.pullAll());
        liveSignals.sync();
        engine.emit('state_restored', restored);
        return sendJson(res, 200, { ok: true, restored, state: engine.getStateSnapshot() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/db/supabase/disconnect' && req.method === 'POST') {
      await supabase.flush().catch(() => {});
      try {
        setEnvValues({ SUPABASE_URL: null, SUPABASE_SERVICE_KEY: null, SUPABASE_KEY: null, SUPABASE_TABLE: null });
      } catch {
        // .env not writable; still disconnect for this run
      }
      supabase.configure({ url: '', key: '' });
      return sendJson(res, 200, { ok: true, ...supabase.status() });
    }

    // 9.4 Clear History list (keeps positions, balances, follows)
    if (pathname === '/api/history/clear' && req.method === 'POST') {
      const result = engine.clearHistory();
      return sendJson(res, 200, { ok: true, ...result, state: engine.getStateSnapshot() });
    }

    // 9.5 Reset Engine State to Clean Baseline (Clears all fake/test data)
    if (pathname === '/api/engine/reset' && req.method === 'POST') {
      const state = engine.resetToCleanState();
      return sendJson(res, 200, { ok: true, state });
    }

    // 9.55 Token metadata & images (Alchemy, proxied so the API key never reaches the browser)
    if (pathname === '/api/tokens/meta' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const items = (body?.items || [{ chain: url.searchParams.get('chain') || 'solana', address: url.searchParams.get('address') }])
        .filter((it) => it && typeof it.address === 'string' && it.address.length >= 32 && it.address.length <= 64)
        .slice(0, 40);
      if (!alchemy.canFetchTokens) {
        return sendJson(res, 200, { ok: true, configured: false, tokens: {} });
      }
      const tokens = {};
      await Promise.all(
        items.map(async (it) => {
          const meta = await alchemy.getToken(it.chain || 'solana', it.address);
          if (meta) tokens[it.address] = meta;
        })
      );
      // Remember logos on open positions so they show after a restart too
      let touched = false;
      for (const p of engine.positions) {
        const img = tokens[p.tokenAddress]?.imageUrl;
        if (!p.imageUrl && img) {
          p.imageUrl = img;
          touched = true;
        }
      }
      if (touched) engine.emit('positions_updated', {});
      return sendJson(res, 200, { ok: true, configured: true, tokens });
    }

    // Trader wallet pictures: an NFT each wallet holds (Alchemy DAS), never a made-up image
    if (pathname === '/api/wallets/avatars' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const list = (body?.addresses || String(url.searchParams.get('addresses') || '').split(','))
        .map((a) => String(a || '').trim())
        .filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
      const addresses = [...new Set(list)].slice(0, 25);
      if (!alchemy.canFetchTokens) return sendJson(res, 200, { ok: true, configured: false, avatars: {} });
      const avatars = {};
      await Promise.all(
        addresses.map(async (a) => {
          avatars[a] = await alchemy.getWalletAvatar(a).catch(() => null);
        })
      );
      return sendJson(res, 200, { ok: true, configured: true, avatars });
    }

    // Real on-chain balance (SOL + USDC) of a Solana address, read through the same RPC as Live Signals
    if (pathname === '/api/external-wallet/balance' && req.method === 'GET') {
      const address = url.searchParams.get('address') || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return sendJson(res, 400, { ok: false, error: 'Invalid Solana address.' });
      try {
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const [r, t] = await Promise.all([
          liveSignals.watcher.rpc('getBalance', [address, { commitment: 'confirmed' }]),
          liveSignals.watcher.rpc('getTokenAccountsByOwner', [address, { mint: USDC }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] })),
        ]);
        const lamports = Number(r?.value ?? r ?? 0);
        const usdc = (t?.value || []).reduce((sum, a) => sum + Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
        const solPrice = CHAINS.solana.nativePriceUsd;
        return sendJson(res, 200, { ok: true, address, sol: lamports / 1e9, usdc, solPriceUsd: solPrice, usd: usdc + (lamports / 1e9) * solPrice });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: alchemy.maskUrl(err.message) });
      }
    }

    if (pathname === '/api/integrations' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, alchemy: alchemy.status() });
    }

    // 9.6 Live wallet signals (signals only)
    if (pathname === '/api/signals' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(true) });
    }
    if (pathname === '/api/signals/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        liveSignals.updateConfig(body);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(false) });
    }
    if (pathname === '/api/signals/watch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (body.action === 'remove') liveSignals.removeManual(body.address);
        else liveSignals.addManual(body.address, body.label);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(false) });
    }
    if (pathname === '/api/signals/poll' && req.method === 'POST') {
      const found = await liveSignals.watcher.pollOnce();
      return sendJson(res, 200, { ok: true, found: found.length, ...liveSignals.snapshot(true) });
    }
    if (pathname === '/api/signals/clear' && req.method === 'POST') {
      liveSignals.clear();
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(true) });
    }

    // 10. Simulate Trader Signal Scenarios (Interactive Testing of Copy Pipeline & Exits)
    if (pathname === '/api/simulate-signal' && req.method === 'POST') {
      // Developer test harness only — made-up trades are never part of normal use
      if (process.env.ODEX_DEV_TOOLS !== '1') {
        return sendJson(res, 404, { ok: false, error: 'Simulated trades are disabled. Copies come only from real wallet swaps.' });
      }
      const body = await readJsonBody(req);
      const scenario = body.scenario || 'normal_buy';
      let activeFollow =
        engine.follows.find((f) => f.id === body.followId) ||
        engine.follows.find((f) => f.status === 'copying') ||
        engine.follows[0];

      if (!activeFollow) {
        if (engine.settings.paperTrading) {
          const autoFollow = {
            id: `fol-${randomUUID().slice(0, 8)}`,
            walletId: engine.getActiveWallet()?.id || 'w-main',
            handle: 'test-trader',
            name: 'Test trader',
            traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
            chainId: 'solana',
            status: 'copying',
            pauseReason: null,
            mode: 'auto-exit',
            sizing: { type: 'fixed', amount: 75 },
            minTradeUsd: 1,
            maxAtRiskUsd: 500,
            maxOpenPositions: 3,
            tpPct: 50,
            slPct: 25,
            // Take Initials on so the "Price Pump (+35%)" test actually exercises the +25% rule
            exitRules: createDefaultExitRules({ takeInitials: { enabled: true } }),
            filtersOverride: {
              pumpOnly: null,
              minMarketCapUsd: null,
              maxMarketCapUsd: null,
              minTraderBuyNative: null,
              maxTraderBuyNative: null,
              stage: null,
            },
            consecutiveLosses: 0,
            createdAt: Date.now(),
          };
          engine.follows.unshift(autoFollow);
          activeFollow = autoFollow;
          engine.emit('follows_updated', { created: [autoFollow] });
        } else {
          return sendJson(res, 400, { ok: false, error: 'Add or resume at least one trader follow first.' });
        }
      }

      const SAMPLE_COINS = [
        { symbol: 'MARS', name: 'Mars Cat', mc: 280_000, price: 0.00028 },
        { symbol: 'GIGA', name: 'Giga Chad Sol', mc: 640_000, price: 0.00064 },
        { symbol: 'PEPEAI', name: 'Pepe Neural', mc: 190_000, price: 0.00019 },
        { symbol: 'BONK2', name: 'Bonk Reloaded', mc: 510_000, price: 0.00051 },
        { symbol: 'WIFHAT', name: 'Dog Wif Neon', mc: 820_000, price: 0.00082 },
      ];
      const pick = SAMPLE_COINS[Math.floor(Math.random() * SAMPLE_COINS.length)];

      let signal;
      if (scenario === 'normal_buy') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 120,
          token: {
            address: `${pick.symbol.toLowerCase()}${randomUUID().slice(0, 8)}Mint`,
            symbol: pick.symbol,
            name: pick.name,
            isLaunchpad: true,
            stage: 'pre-grad',
            marketCapUsd: pick.mc,
            traderFillPriceUsd: pick.price,
            currentPriceUsd: Number((pick.price * 1.04).toFixed(8)), // +4% chase (well below 25% Max Chase)
            safety: { safetyVerified: true },
          },
        };
      } else if (scenario === 'high_chase_skip') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 200,
          token: {
            address: `chase${randomUUID().slice(0, 8)}Mint`,
            symbol: 'RUNNER',
            name: 'Runner Test',
            isLaunchpad: true,
            stage: 'graduated',
            marketCapUsd: 950_000,
            traderFillPriceUsd: 0.0005,
            currentPriceUsd: 0.00074, // +48% above trader fill -> triggers Max Chase skip (>25%)
            safety: { safetyVerified: true },
          },
        };
      } else if (scenario === 'honeypot_skip') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 90,
          token: {
            address: `rug${randomUUID().slice(0, 8)}Mint`,
            symbol: 'SQUID2',
            name: 'Squid Honeypot',
            isLaunchpad: false,
            stage: 'graduated',
            marketCapUsd: 310_000,
            traderFillPriceUsd: 0.00031,
            currentPriceUsd: 0.00032,
            safety: {
              freezeAuthority: true,
              honeypot: true,
              practiceSellFailed: true,
            },
          },
        };
      } else if (scenario === 'leader_sell') {
        const openForFollow =
          engine.positions.find((p) => p.followId === activeFollow.id && p.remainingTokens > 0) ||
          engine.positions.find((p) => p.remainingTokens > 0);
        signal = {
          chainId: openForFollow ? openForFollow.chainId : activeFollow.chainId,
          side: 'sell',
          sellSharePct: 100,
          traderHandle: openForFollow ? openForFollow.traderHandle : activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          token: {
            address: openForFollow ? openForFollow.tokenAddress : 'unknown',
            symbol: openForFollow ? openForFollow.symbol : 'MANLET',
          },
        };
      } else if (scenario === 'pump_open_positions') {
        const map = {};
        for (const p of engine.positions) {
          if (p.remainingTokens > 0) map[p.id] = 1.35; // +35% jump -> triggers Take Initials (+25%) or TP
        }
        await engine.tickMarketPrices(map);
        return sendJson(res, 200, { ok: true, scenario, state: engine.getStateSnapshot() });
      }

      const results = await engine.processTraderSignal(signal);
      return sendJson(res, 200, { ok: true, scenario, results, state: engine.getStateSnapshot() });
    }

    // 11. Static file serving from public/
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    // Page addresses (/login, /settings, /settings/profile, /positions, /signals, …) are all the
    // one-page app; the browser picks the page from the address. Files keep their extension.
    if (!path.extname(pathname) && !pathname.startsWith('/api/')) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = await fs.readFile(filePath);
      // the page itself is never cached, so a new version shows on the next load
      // pages, styles and scripts are revalidated on every load so an update shows after a normal refresh
      res.writeHead(200, /\.(html|css|js)$/.test(filePath) ? { 'Content-Type': contentType, 'Cache-Control': 'no-cache' } : { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  } catch (err) {
    sendJson(res, err?.statusCode || 500, { ok: false, error: err?.message || 'Internal Server Error' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  server.listen(PORT, HOST, () => {
    if (ON_RAILWAY) console.log(`Railway: listening on ${HOST}:${PORT}${process.env.RAILWAY_PUBLIC_DOMAIN ? ` (https://${process.env.RAILWAY_PUBLIC_DOMAIN})` : ''}; site password ${SITE_PASSWORD ? 'ON' : 'OFF — set ODEX_PASSWORD'}`);
    if (realBlockedReason && realTrader.ready()) console.log(`Real trading: ${realBlockedReason}`);
    if (realTrader.keyError) console.log(`Real trading: ${realTrader.keyError}`);
    else if (realTrader.ready()) {
      const c = realTrader.caps;
      console.log(`Real trading: bot wallet ${realTrader.address} loaded (max ${c.maxSolPerTrade} SOL per buy, ${c.maxSolPerDay || 'no'} SOL per 24 h)`);
      if (!engine.settings.paperTrading) console.log('*** REAL TRADING IS ACTIVE (Paper Trading is OFF) — copies spend real SOL ***');
      refreshRealBalance();
    }
    console.log(`Odex Mirror Web Terminal running at http://localhost:${PORT}${HOST === '127.0.0.1' ? ' (this computer only)' : ` (open to your network on ${HOST})`}`);
    console.log(
      alchemy.enabled
        ? `Alchemy: connected (key ${alchemy.status().keyMasked}${envFile.keys.includes('ALCHEMY_API_KEY') ? ', from .env' : ''})`
        : 'Alchemy: not configured — add ALCHEMY_API_KEY to .env for token images and a faster Solana RPC'
    );
    if (persistence) {
      const r = persistence.restored;
      console.log(
        `Database: ${db.kind === 'sqlite' ? 'SQLite' : 'JSON file'} · ${path.relative(__dirname, db.file)}${
          r ? ` · restored ${r.follows ?? 0} follows, ${r.openPositions ?? 0} open positions, ${r.history ?? 0} history entries` : ' · new database'
        }`
      );
    } else {
      console.log('Database: off (ODEX_DB=off) — data is lost on restart');
    }
    console.log(supabase.enabled ? `Supabase: cloud backup ON · ${supabase.status().host} · table ${supabase.table}` : 'Supabase: not connected (optional cloud backup — connect in Settings → Data & storage)');
    liveSignals.sync();
    console.log(
      `Live wallet watching: ${liveSignals.config.enabled ? 'ON' : 'OFF'} · copying followed wallets ${liveSignals.config.paperCopy ? 'ON (paper)' : 'OFF (signals only)'} · RPC ${liveSignals.maskedRpcUrl()}`
    );
  });
}

// Save everything before the process exits (Ctrl+C, terminal closed, service stop)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  liveSignals.watcher.stop();
  const done = () => process.exit(0);
  setTimeout(done, 4000).unref?.(); // never hang on exit
  if (!persistence) return done();
  persistence
    .closeAsync()
    .then(() => console.log(`\n${signal}: data saved to ${db.kind === 'sqlite' ? 'SQLite' : 'JSON'} database${supabase.enabled ? ' and Supabase' : ''}. Bye.`))
    .catch(() => {})
    .finally(done);
}
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows console close / Ctrl+Break
}

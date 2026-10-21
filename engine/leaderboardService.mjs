/**
 * Live Leaderboard & Trader Profile Lookup Service
 *
 * Fetches live signal rankings directly from https://fomotop.money/api/v1/leaderboard.json
 * (pre-sorted by 95% Wilson score lower bound of 48h >=+50% peak win rate).
 */

const LIVE_LEADERBOARD_URL = 'https://fomotop.money/api/v1/leaderboard.json';
const CACHE_TTL_MS = 45_000;

let cachedData = null;
let lastFetchTime = 0;

function enrichEntry(entry, idx) {
  return {
    ...entry,
    rank: entry.rank || idx + 1,
    evmWallet: entry.evmWallet || null,
    chains: entry.chains || ['solana'],
  };
}

export async function getLeaderboardData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedData && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedData;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(LIVE_LEADERBOARD_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      if (json && json.leaderboard) {
        const windows = {};
        for (const [winKey, list] of Object.entries(json.leaderboard)) {
          windows[winKey] = Array.isArray(list) ? list.map(enrichEntry) : [];
        }
        cachedData = {
          version: json.version || '1.0',
          generated_at: json.generated_at || new Date().toISOString(),
          source: json.source || 'https://fomotop.money',
          live: true,
          methodology: json.methodology || {},
          summary: json.summary || {},
          leaderboard: windows,
        };
        lastFetchTime = now;
        return cachedData;
      }
    }
  } catch {
    if (cachedData) return cachedData;
  }

  return (
    cachedData || {
      version: '1.0',
      generated_at: new Date().toISOString(),
      source: LIVE_LEADERBOARD_URL,
      live: false,
      methodology: {},
      summary: {
        tracked_wallets: 0,
        total_picks: 0,
        overall_hit_rate_pct: 0,
      },
      leaderboard: { '2d': [], '7d': [], '30d': [], all: [] },
    }
  );
}

/**
 * Resolves a handle (e.g. `@frankdegods` or `frankdegods`) against the live leaderboard
 * or validates a pasted Solana / 0x wallet address.
 * Never guesses an address if a handle is unknown.
 */
export async function lookupTrader(query) {
  const raw = String(query || '').trim();
  if (!raw) {
    return { ok: false, error: 'Enter a trader @handle, Solana address, or 0x EVM address.' };
  }

  const data = await getLeaderboardData();
  const pools = [
    ...(data.leaderboard['7d'] || []),
    ...(data.leaderboard['30d'] || []),
    ...(data.leaderboard['2d'] || []),
    ...(data.leaderboard.all || []),
  ];

  // Check if raw EVM 0x address
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const matched = pools.find((t) => t.evmWallet?.toLowerCase() === raw.toLowerCase());
    return {
      ok: true,
      inputType: 'evm_address',
      trader: matched || {
        handle: `${raw.slice(0, 6)}…${raw.slice(-4)}`,
        wallet: null,
        evmWallet: raw,
        win_rate_pct: null,
        median_peak_pct: null,
        picks: null,
        wins: null,
        chains: ['bsc', 'robinhood', 'arc'],
        dataAgeSec: 0,
      },
    };
  }

  // Check if raw Solana base58 address (32-44 base58 chars, not starting with @)
  if (!raw.startsWith('@') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
    const matched = pools.find((t) => t.wallet === raw);
    return {
      ok: true,
      inputType: 'solana_address',
      trader: matched
        ? { ...matched, chains: ['solana'] }
        : {
            handle: `${raw.slice(0, 4)}…${raw.slice(-4)}`,
            wallet: raw,
            evmWallet: null,
            win_rate_pct: null,
            median_peak_pct: null,
            picks: null,
            wins: null,
            chains: ['solana'],
            dataAgeSec: 0,
          },
    };
  }

  // Handle lookup against live leaderboard
  const cleanHandle = raw.replace(/^@/, '').toLowerCase();
  const found = pools.find((t) => String(t.handle || '').toLowerCase() === cleanHandle);
  if (!found) {
    return {
      ok: false,
      error: `No profile or verified wallet found for @${cleanHandle}. Check the spelling or paste the exact Solana / 0x wallet address directly (Odex Mirror never guesses an address).`,
    };
  }

  return {
    ok: true,
    inputType: 'handle',
    trader: {
      ...found,
      dataAgeSec: Math.max(
        1,
        Math.floor((Date.now() - (new Date(data.generated_at).getTime() || Date.now())) / 1000)
      ),
    },
  };
}

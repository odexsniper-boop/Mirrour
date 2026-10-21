/**
 * Alchemy integration (server-side only — the API key never reaches the browser).
 *
 *  - Solana RPC URL for the live wallet watcher (higher limits than the public RPC)
 *  - Solana token metadata + image via the DAS `getAsset` method
 *  - EVM token metadata + logo via `alchemy_getTokenMetadata` (BSC)
 *
 * Responses are cached; failures are cached briefly so a bad token doesn't hammer the API.
 */
import { maskSecret, redact } from './env.mjs';

const EVM_NETWORKS = {
  bsc: 'bnb-mainnet',
  // Robinhood Chain / Arc: not known Alchemy networks yet → metadata falls back to DexScreener
};

const OK_TTL_MS = 6 * 60 * 60 * 1000; // token metadata rarely changes
const FAIL_TTL_MS = 5 * 60 * 1000;

/** ipfs:// and ar:// → public HTTPS gateways; reject anything that isn't http(s) */
export function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}`;
  if (u.startsWith('ar://')) return `https://arweave.net/${u.slice(5)}`;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

/** Pull name / symbol / image / authorities out of a DAS getAsset result (field names vary by provider). */
export function parseDasAsset(asset) {
  if (!asset || typeof asset !== 'object') return null;
  const content = asset.content || {};
  const meta = content.metadata || {};
  const tokenInfo = asset.token_info || asset.tokenInfo || {};
  const files = Array.isArray(content.files) ? content.files : [];
  const imageFile = files.find((f) => /^image\//.test(f?.mime || '')) || files[0];
  const image =
    normalizeImageUrl(content.links?.image) ||
    normalizeImageUrl(imageFile?.cdn_uri) ||
    normalizeImageUrl(imageFile?.uri) ||
    null;

  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  const authorityKnown = has(tokenInfo, 'mint_authority') || has(tokenInfo, 'freeze_authority');

  return {
    name: meta.name || tokenInfo.name || null,
    symbol: meta.symbol || tokenInfo.symbol || null,
    imageUrl: image,
    decimals: tokenInfo.decimals ?? null,
    supply: tokenInfo.supply ?? null,
    priceUsd: tokenInfo.price_info?.price_per_token ?? null,
    mintAuthority: authorityKnown ? tokenInfo.mint_authority || null : undefined,
    freezeAuthority: authorityKnown ? tokenInfo.freeze_authority || null : undefined,
    authorityKnown,
    mutable: asset.mutable ?? null,
    source: 'alchemy',
  };
}

const NFT_INTERFACES = new Set(['V1_NFT', 'V2_NFT', 'ProgrammableNFT', 'LEGACY_NFT', 'MplCoreAsset']);

/**
 * Pick a profile picture from the NFTs a wallet holds (DAS getAssetsByOwner items).
 * Spam guard: compressed NFTs (mostly airdropped spam), burnt items and items without an
 * image or collection are skipped; verified collections / creators rank first.
 */
export function pickWalletAvatar(items) {
  const cands = [];
  for (const a of Array.isArray(items) ? items : []) {
    if (!a || a.burnt || !NFT_INTERFACES.has(a.interface)) continue;
    if (a.compression?.compressed) continue;
    const parsed = parseDasAsset(a);
    if (!parsed?.imageUrl) continue;
    const name = parsed.name || '';
    if (/(claim|reward|airdrop|voucher|visit|\.com|\.io|\.xyz|https?:|www\.)/i.test(`${name} ${a.content?.metadata?.description || ''}`)) continue;
    const collection = (a.grouping || []).find((g) => g?.group_key === 'collection');
    if (!collection) continue;
    const verifiedCollection = collection.verified !== false;
    const verifiedCreator = (a.creators || []).some((c) => c?.verified);
    cands.push({ score: (verifiedCollection ? 2 : 0) + (verifiedCreator ? 1 : 0), imageUrl: parsed.imageUrl, name: name || null, mint: a.id || null, collection: collection.group_value || null });
  }
  cands.sort((x, y) => y.score - x.score);
  return cands[0] ? { imageUrl: cands[0].imageUrl, name: cands[0].name, mint: cands[0].mint, collection: cands[0].collection, source: 'nft' } : null;
}

export class AlchemyService {
  constructor({ apiKey = '', fetchImpl = (...a) => fetch(...a) } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.inflight = new Map();
    this.stats = { calls: 0, errors: 0, lastError: null, lastOkAt: null, consecutiveFailures: 0 };
    this.maxConcurrent = 4; // Alchemy answers 429/503 when bursts get too big
    this.active = 0;
    this.queue = [];
    this.retryDelaysMs = [500, 1500];
    this.fallback = null; // OnchainMetadata: plain-RPC metadata when DAS is down / not configured
    this.das = { failures: 0, downUntil: 0, lastError: null };
    this.dasParamStyle = 'named'; // flips to 'positional' if the endpoint rejects named params
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  /** Token logos / wallet pictures can be fetched (Alchemy DAS or the on-chain fallback). */
  get canFetchTokens() {
    return this.enabled || Boolean(this.fallback?.enabled);
  }

  dasAvailable() {
    return this.enabled && Date.now() >= this.das.downUntil;
  }

  dasResult(err) {
    if (!err) {
      this.das.failures = 0;
      this.das.downUntil = 0;
      return;
    }
    if (err.transient || /HTTP 5\d\d|timed out/i.test(err.message)) {
      this.das.failures += 1;
      this.das.lastError = redact(err.message, this.apiKey);
      // 3 busy/unavailable answers in a row → leave DAS alone for 5 minutes, use the fallback
      if (this.das.failures >= 3) this.das.downUntil = Date.now() + 5 * 60_000;
    }
  }

  solanaRpcUrl() {
    return this.enabled ? `https://solana-mainnet.g.alchemy.com/v2/${this.apiKey}` : null;
  }

  evmRpcUrl(chainId) {
    const net = EVM_NETWORKS[chainId];
    return this.enabled && net ? `https://${net}.g.alchemy.com/v2/${this.apiKey}` : null;
  }

  /** Safe to send to the browser */
  status() {
    return {
      configured: this.enabled,
      keyMasked: maskSecret(this.apiKey),
      calls: this.stats.calls,
      errors: this.stats.errors,
      lastError: this.stats.lastError,
      lastOkAt: this.stats.lastOkAt,
      lastErrorAt: this.stats.lastErrorAt || null,
      consecutiveFailures: this.stats.consecutiveFailures,
      das: { down: Date.now() < this.das.downUntil, downUntil: this.das.downUntil || null, lastError: this.das.lastError },
      fallback: this.fallback ? { ...this.fallback.stats } : null,
      evmChains: Object.keys(EVM_NETWORKS),
    };
  }

  maskUrl(url) {
    return redact(url, this.apiKey);
  }

  async slot() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** One JSON-RPC call: limited concurrency, retries on busy / unavailable / timeout. */
  async rpc(url, method, params) {
    await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.rpcOnce(url, method, params);
          this.stats.lastOkAt = Date.now();
          this.stats.consecutiveFailures = 0;
          return result;
        } catch (err) {
          if (err.transient && attempt < this.retryDelaysMs.length) {
            await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt] * (1 + Math.random() * 0.3)));
            continue;
          }
          this.stats.errors += 1;
          this.stats.lastError = redact(err.name === 'AbortError' ? 'Alchemy request timed out' : err.message, this.apiKey);
          // parameter-style retries and unknown tokens are normal; only count real failures as health problems
          if (!(err.rpcCode === -32602 || /not found|invalid param/i.test(err.message))) {
            this.stats.lastErrorAt = Date.now();
            this.stats.consecutiveFailures += 1;
          }
          throw err;
        }
      }
    } finally {
      this.release();
    }
  }

  async rpcOnce(url, method, params) {
    this.stats.calls += 1;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.stats.calls, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`Alchemy HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : res.status === 503 ? ' (temporarily unavailable)' : ''}`);
        err.transient = res.status === 429 || res.status >= 500;
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(`Alchemy ${method}: ${json.error.message || json.error.code}`);
        err.rpcCode = json.error.code;
        err.transient = json.error.code === 429 || json.error.code === -32005;
        throw err;
      }
      return json.result;
    } catch (err) {
      if (err.name === 'AbortError' || /fetch failed|ECONNRESET|socket/i.test(err.message)) err.transient = true;
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async cached(key, loader) {
    const hit = this.cache.get(key);
    if (hit && Date.now() < hit.until) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        this.cache.set(key, { value, until: Date.now() + (value ? OK_TTL_MS : FAIL_TTL_MS) });
        return value;
      } catch (err) {
        // busy / unavailable → try again soon; a real error waits longer
        this.cache.set(key, { value: null, until: Date.now() + (err?.transient ? 30_000 : FAIL_TTL_MS) });
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async dasGetAsset(mint) {
    const url = this.solanaRpcUrl();
    const named = { id: mint, displayOptions: { showFungible: true } };
    const positional = [mint, { showFungible: true }];
    try {
      return await this.rpc(url, 'getAsset', this.dasParamStyle === 'named' ? named : positional);
    } catch (err) {
      // Invalid params → try the other parameter style once and remember it
      if (err.rpcCode === -32602 || /param/i.test(err.message)) {
        this.dasParamStyle = this.dasParamStyle === 'named' ? 'positional' : 'named';
        return this.rpc(url, 'getAsset', this.dasParamStyle === 'named' ? named : positional);
      }
      throw err;
    }
  }

  async getSolanaToken(mint) {
    if (!mint || !this.canFetchTokens) return null;
    return this.cached(`sol:${mint}`, async () => {
      let das = null;
      let dasErr = null;
      if (this.dasAvailable()) {
        try {
          das = parseDasAsset(await this.dasGetAsset(mint));
          this.dasResult(null);
        } catch (err) {
          dasErr = err;
          this.dasResult(err);
        }
      }
      if (das?.imageUrl || !this.fallback?.enabled) {
        if (!das && dasErr) throw dasErr;
        return das;
      }
      const chain = await this.fallback.getToken(mint).catch(() => null);
      if (!chain) {
        if (!das && dasErr) throw dasErr;
        return das;
      }
      return das ? { ...das, imageUrl: chain.imageUrl, name: das.name || chain.name, symbol: das.symbol || chain.symbol } : chain;
    });
  }

  /** Profile picture for a Solana wallet, taken from an NFT it holds (cached). */
  async getWalletAvatar(owner) {
    if (!this.canFetchTokens || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner || '')) return null;
    return this.cached(`avatar:${owner}`, async () => {
      if (this.dasAvailable()) {
        try {
          const url = this.solanaRpcUrl();
          let result;
          try {
            result = await this.rpc(url, 'getAssetsByOwner', { ownerAddress: owner, page: 1, limit: 100, displayOptions: { showFungible: false, showUnverifiedCollections: false } });
          } catch (err) {
            if (err.rpcCode === -32602 || /param/i.test(err.message)) result = await this.rpc(url, 'getAssetsByOwner', { ownerAddress: owner, page: 1, limit: 100 });
            else throw err;
          }
          this.dasResult(null);
          const pick = pickWalletAvatar(result?.items);
          if (pick || !this.fallback?.enabled) return pick;
        } catch (err) {
          this.dasResult(err);
          if (!this.fallback?.enabled) throw err;
        }
      }
      return this.fallback?.enabled ? this.fallback.getWalletAvatar(owner) : null;
    });
  }

  async getEvmToken(chainId, address) {
    const url = this.evmRpcUrl(chainId);
    if (!url || !/^0x[a-fA-F0-9]{40}$/.test(address || '')) return null;
    return this.cached(`${chainId}:${address.toLowerCase()}`, async () => {
      const r = await this.rpc(url, 'alchemy_getTokenMetadata', [address]);
      if (!r) return null;
      return {
        name: r.name || null,
        symbol: r.symbol || null,
        decimals: r.decimals ?? null,
        imageUrl: normalizeImageUrl(r.logo),
        authorityKnown: false,
        source: 'alchemy',
      };
    });
  }

  async getToken(chainId, address) {
    if (chainId === 'solana') return this.getSolanaToken(address);
    return this.getEvmToken(chainId, address);
  }
}

/**
 * On-chain token / NFT metadata through plain Solana RPC (no Alchemy DAS needed).
 *
 * Used when Alchemy's DAS API (getAsset / getAssetsByOwner) is down or not configured:
 *  - token logo + name + symbol: Metaplex metadata account → its JSON uri → "image"
 *  - trader wallet picture: NFTs in the wallet (amount 1, decimals 0) → verified-collection
 *    Metaplex metadata → JSON → "image"
 * Zero dependencies: base58, PDA derivation (sha256 + ed25519 off-curve check) and the
 * metadata layout are implemented here.
 */
import { createHash } from 'node:crypto';
import { normalizeImageUrl } from './alchemy.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHA_MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(str) {
  let n = 0n;
  for (const c of String(str)) {
    const v = ALPHA_MAP[c];
    if (v === undefined) throw new Error('invalid base58');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of String(str)) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// ---- ed25519: is a 32-byte string a valid curve point? (PDAs must NOT be) ----
const P = 2n ** 255n - 19n;
const modp = (a) => ((a % P) + P) % P;
function powmod(b, e) {
  let r = 1n;
  b = modp(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = modp(-121665n * powmod(121666n, P - 2n));

export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n);
  const v = modp(D * y2 + 1n);
  if (u === 0n) return true;
  const x2 = (u * powmod(v, P - 2n)) % P;
  return powmod(x2, (P - 1n) / 2n) === 1n; // x² must be a square
}

export function findProgramAddress(seeds, programId) {
  const prog = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(prog);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const out = h.digest();
    if (!isOnCurve(out)) return base58Encode(out);
  }
  throw new Error('no program address');
}

export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function metadataPda(mint) {
  return findProgramAddress([Buffer.from('metadata'), base58Decode(METADATA_PROGRAM), base58Decode(mint)], METADATA_PROGRAM);
}

/** Decode a Metaplex Token Metadata account (base64 or Buffer). */
export function parseMetadataAccount(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  if (b.length < 70 || b[0] !== 4) return null; // key 4 = MetadataV1
  let o = 1 + 32;
  const mint = base58Encode(b.subarray(o, o + 32));
  o += 32;
  const str = () => {
    const len = b.readUInt32LE(o);
    o += 4;
    const s = b.subarray(o, o + len).toString('utf8').replace(/\0/g, '').trim();
    o += len;
    return s;
  };
  try {
    const name = str();
    const symbol = str();
    const uri = str();
    o += 2; // seller fee
    const creators = [];
    if (b[o++] === 1) {
      const n = b.readUInt32LE(o);
      o += 4;
      for (let i = 0; i < n; i++) {
        creators.push({ address: base58Encode(b.subarray(o, o + 32)), verified: b[o + 32] === 1 });
        o += 34;
      }
    }
    o += 2; // primary sale, is mutable
    if (b[o++] === 1) o += 1; // edition nonce
    let tokenStandard = null;
    if (o < b.length && b[o++] === 1) tokenStandard = b[o++];
    let collection = null;
    if (o < b.length && b[o++] === 1) {
      collection = { verified: b[o] === 1, key: base58Encode(b.subarray(o + 1, o + 33)) };
      o += 33;
    }
    return { mint, name, symbol, uri, creators, tokenStandard, collection };
  } catch {
    return null;
  }
}

const SPAM_RE = /(claim|reward|airdrop|voucher|visit|\.com|\.io|\.xyz|https?:|www\.)/i;

export class OnchainMetadata {
  /** @param rpc async (method, params) => result — the app's normal Solana RPC */
  constructor({ rpc, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.rpc = rpc;
    this.fetch = fetchImpl;
    this.stats = { calls: 0, errors: 0, lastOkAt: null, lastError: null, lastErrorAt: null };
  }

  get enabled() {
    return typeof this.rpc === 'function';
  }

  async fetchJson(uri) {
    const url = normalizeImageUrl(uri);
    if (!url || !/^https:\/\//i.test(url)) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > 300_000) return null;
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async call(method, params) {
    this.stats.calls += 1;
    try {
      const r = await this.rpc(method, params);
      this.stats.lastOkAt = Date.now();
      return r;
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err.message;
      this.stats.lastErrorAt = Date.now();
      throw err;
    }
  }

  /** { name, symbol, imageUrl, source } for a token mint, or null.
   *  Token-2022 mints (new pump.fun tokens) carry metadata in the mint itself; classic SPL
   *  tokens use a Metaplex metadata account. One RPC call reads both. */
  async getToken(mint) {
    if (!this.enabled) return null;
    const pda = metadataPda(mint);
    const r = await this.call('getMultipleAccounts', [[mint, pda], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const [mintAcc, metaAcc] = r?.value || [];
    let name = null;
    let symbol = null;
    let uri = null;
    const ext = (mintAcc?.data?.parsed?.info?.extensions || []).find((e) => e?.extension === 'tokenMetadata')?.state;
    if (ext) {
      name = ext.name || null;
      symbol = ext.symbol || null;
      uri = ext.uri || null;
    }
    if (!uri && metaAcc?.data) {
      const raw = Array.isArray(metaAcc.data) ? metaAcc.data[0] : null;
      const meta = raw ? parseMetadataAccount(raw) : null;
      if (meta) {
        name = name || meta.name || null;
        symbol = symbol || meta.symbol || null;
        uri = meta.uri || null;
      }
    }
    if (!uri && !name) return null;
    const json = uri ? await this.fetchJson(uri) : null;
    return {
      name: name || json?.name || null,
      symbol: symbol || json?.symbol || null,
      imageUrl: normalizeImageUrl(json?.image) || null,
      decimals: mintAcc?.data?.parsed?.info?.decimals ?? null,
      authorityKnown: Boolean(mintAcc?.data?.parsed?.info),
      mintAuthority: mintAcc?.data?.parsed?.info ? mintAcc.data.parsed.info.mintAuthority || null : undefined,
      freezeAuthority: mintAcc?.data?.parsed?.info ? mintAcc.data.parsed.info.freezeAuthority || null : undefined,
      source: 'onchain',
    };
  }

  /** Picture for a wallet from an NFT it holds (verified collection), or null. */
  async getWalletAvatar(owner) {
    if (!this.enabled) return null;
    const res = await this.call('getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const mints = [];
    for (const a of res?.value || []) {
      const info = a?.account?.data?.parsed?.info;
      const amt = info?.tokenAmount;
      if (amt && amt.decimals === 0 && amt.amount === '1' && info.mint) mints.push(info.mint);
      if (mints.length >= 60) break;
    }
    if (!mints.length) return null;
    const pdas = mints.map((m) => metadataPda(m));
    const accounts = [];
    for (let i = 0; i < pdas.length; i += 100) {
      const r = await this.call('getMultipleAccounts', [pdas.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
      accounts.push(...(r?.value || []));
    }
    const cands = [];
    accounts.forEach((acc, i) => {
      const meta = acc?.data?.[0] ? parseMetadataAccount(acc.data[0]) : null;
      if (!meta || !meta.uri || !meta.collection?.verified) return;
      if (meta.tokenStandard !== null && ![0, 4].includes(meta.tokenStandard)) return; // NonFungible / Programmable only
      if (SPAM_RE.test(meta.name)) return;
      cands.push({ mint: mints[i], meta, score: meta.creators.some((c) => c.verified) ? 1 : 0 });
    });
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 5)) {
      const json = await this.fetchJson(c.meta.uri);
      const img = normalizeImageUrl(json?.image);
      if (img && /^https:\/\//i.test(img) && !SPAM_RE.test(`${json?.description || ''}`)) {
        return { imageUrl: img, name: c.meta.name || json?.name || null, mint: c.mint, collection: c.meta.collection.key, source: 'nft' };
      }
    }
    return null;
  }
}

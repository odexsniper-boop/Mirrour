/**
 * Real Solana trading — zero dependencies.
 *
 * Signs Jupiter Swap API v2 orders with the bot wallet's private key (Ed25519 via node:crypto)
 * and reports exact on-chain fills back to the copy engine. Used only when Paper Trading is OFF
 * and ODEX_TRADER_KEY is set in .env.
 *
 * Safety:
 *   - per-trade and rolling 24 h buy caps (in SOL), a SOL reserve kept for fees
 *   - the private key never leaves this module (never logged, saved or sent to the browser)
 *   - a swap whose result is unknown (timeout) is looked up on-chain before anything is recorded
 */
import crypto from 'node:crypto';
import { base58Decode, base58Encode } from './onchainMeta.mjs';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PXnBqCXEpPxuEb';
const LAMPORTS = 1_000_000_000;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DAY_MS = 86_400_000;

// ---------- keys & signing ----------

/** Accepts a base58 secret key (64-byte Phantom/Solflare export or 32-byte seed) or a JSON byte array. */
export function loadKeypair(secret) {
  const s = String(secret || '').trim();
  if (!s) throw new Error('no key');
  let bytes;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('key JSON must be an array of numbers');
    bytes = Uint8Array.from(arr);
  } else {
    bytes = base58Decode(s);
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error(`key must be 64 or 32 bytes (got ${bytes.length})`);
  const seed = Buffer.from(bytes.subarray(0, 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (bytes.length === 64 && !Buffer.from(bytes.subarray(32)).equals(pub)) {
    throw new Error('key is damaged: its public half does not match the private half');
  }
  const publicKey = base58Encode(pub);
  return Object.freeze({
    publicKey,
    publicKeyBytes: Buffer.from(pub),
    sign: (msg) => crypto.sign(null, msg, privateKey),
    verify: (msg, sig) => crypto.verify(null, msg, crypto.createPublicKey(privateKey), sig),
  });
}

function readCompactU16(buf, off) {
  let len = 0;
  let size = 0;
  for (;;) {
    if (off + size >= buf.length || size > 2) throw new Error('bad transaction (length field)');
    const b = buf[off + size];
    len |= (b & 0x7f) << (7 * size);
    size += 1;
    if ((b & 0x80) === 0) break;
  }
  return [len, size];
}

/**
 * Sign a serialized legacy / v0 transaction (base64) in our signer slot. Other signer slots
 * (e.g. a market maker's) are left untouched. Returns { signedBase64, signature }.
 */
export function signTransactionBase64(b64, keypair) {
  const tx = Buffer.from(String(b64), 'base64');
  const [numSigs, sigLenSize] = readCompactU16(tx, 0);
  const msgOff = sigLenSize + 64 * numSigs;
  if (numSigs < 1 || msgOff >= tx.length) throw new Error('bad transaction (no signature slots)');
  const msg = tx.subarray(msgOff);
  let o = 0;
  if (msg[0] & 0x80) {
    const version = msg[0] & 0x7f;
    if (version !== 0) throw new Error(`transaction version ${version} is not supported`);
    o = 1;
  }
  const numRequired = msg[o];
  o += 3;
  const [numKeys, keysLenSize] = readCompactU16(msg, o);
  o += keysLenSize;
  let slot = -1;
  for (let i = 0; i < Math.min(numRequired, numKeys, numSigs); i++) {
    if (msg.subarray(o + 32 * i, o + 32 * i + 32).equals(keypair.publicKeyBytes)) {
      slot = i;
      break;
    }
  }
  if (slot < 0) throw new Error('this transaction is not for the bot wallet (signer not found)');
  const sig = keypair.sign(msg);
  sig.copy(tx, sigLenSize + 64 * slot);
  // the transaction id is the first signature (the fee payer's)
  const firstSig = slot === 0 ? sig : tx.subarray(sigLenSize, sigLenSize + 64);
  return { signedBase64: tx.toString('base64'), signature: base58Encode(firstSig), slot };
}

// ---------- the trader ----------

export class RealTrader {
  /**
   * @param env       process.env (ODEX_TRADER_KEY, JUPITER_API_KEY, caps)
   * @param rpc       (method, params) => result   Solana JSON-RPC
   * @param solPrice  () => SOL price in USD
   * @param state     saved state (spend log, trade log) from the database
   * @param onChange  called after every trade so the state can be saved
   */
  constructor({ env = process.env, rpc, solPrice, fetchImpl = (...a) => fetch(...a), state = null, onChange = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
    this.rpc = rpc;
    this.solPrice = solPrice;
    this.fetch = fetchImpl;
    this.onChange = onChange;
    this.sleep = sleep;
    this.now = now;
    this.jupBase = (env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2').replace(/\/+$/, '');
    this.jupKey = env.JUPITER_API_KEY || '';
    const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    this.caps = {
      maxSolPerTrade: num(env.ODEX_REAL_MAX_SOL_PER_TRADE, 0.5),
      maxSolPerDay: num(env.ODEX_REAL_MAX_SOL_PER_DAY, 2), // 0 = no daily cap
      reserveSol: num(env.ODEX_REAL_RESERVE_SOL, 0.02), // kept for fees + token-account rent
      sellRetrySec: num(env.ODEX_REAL_SELL_RETRY_SEC, 3), // exits retry fast: a falling coin can't wait
    };
    this.keypair = null;
    this.keyError = null;
    const secret = env.ODEX_TRADER_KEY || '';
    if (secret) {
      try {
        this.keypair = loadKeypair(secret);
      } catch (err) {
        this.keyError = `ODEX_TRADER_KEY: ${err.message}`;
      }
    }
    this.decimals = new Map([[WSOL_MINT, 9], [USDC_MINT, 6]]);
    this.spendLog = Array.isArray(state?.spendLog) ? state.spendLog : []; // [{ t, sol }]
    this.trades = Array.isArray(state?.trades) ? state.trades : []; // newest first
    this.lastError = null;
    this.balance = null; // { sol, usdc, at }
    this.sellBlockedUntil = new Map(); // mint -> time (back-off after a failed sell)
    this.pendingBuySol = 0; // SOL of buys signed/sending but not finished yet
    this.prefetchedBalance = null; // { at, promise }: balance read while Jupiter quotes a buy
    this.lastBuyDoneAt = 0; // a balance read before this moment may still hold a finished buy's SOL
  }

  get address() {
    return this.keypair?.publicKey || null;
  }

  ready() {
    return Boolean(this.keypair) && typeof this.rpc === 'function';
  }

  exportState() {
    return { spendLog: this.spendLog.slice(-500), trades: this.trades.slice(0, 300) };
  }

  spent24hSol() {
    const cutoff = this.now() - DAY_MS;
    this.spendLog = this.spendLog.filter((x) => x.t >= cutoff);
    return this.spendLog.reduce((a, x) => a + x.sol, 0);
  }

  /** USD a real buy may use right now under the per-trade and 24 h caps (NaN if SOL price unknown). */
  buyRoomUsd() {
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) return NaN;
    const perTrade = this.caps.maxSolPerTrade > 0 ? this.caps.maxSolPerTrade : Infinity;
    const daily = this.caps.maxSolPerDay > 0 ? Math.max(0, this.caps.maxSolPerDay - this.spent24hSol() - this.pendingBuySol) : Infinity;
    const sol = Math.min(perTrade, daily);
    return Number.isFinite(sol) ? sol * px * 0.999 : Infinity;
  }

  status() {
    return {
      configured: Boolean(this.keypair),
      ready: this.ready(),
      address: this.address,
      keyError: this.keyError,
      jupiterKey: Boolean(this.jupKey),
      caps: { ...this.caps },
      spent24hSol: Number(this.spent24hSol().toFixed(6)),
      balance: this.balance,
      lastError: this.lastError,
      lastTrade: this.trades[0] || null,
      trades: this.trades.slice(0, 20),
    };
  }

  // ---------- chain reads ----------

  async getDecimals(mint) {
    if (this.decimals.has(mint)) return this.decimals.get(mint);
    const r = await this.rpc('getTokenSupply', [mint]);
    const d = Number(r?.value?.decimals);
    if (!Number.isInteger(d)) throw new Error('could not read token decimals');
    this.decimals.set(mint, d);
    return d;
  }

  /** Raw (integer) token balance of the bot wallet for one mint, across all its token accounts. */
  async getTokenBalanceRaw(mint) {
    const sum = (r, onlyMint) => {
      let raw = 0n;
      for (const acc of r?.value || []) {
        const info = acc?.account?.data?.parsed?.info;
        if (onlyMint && info?.mint !== mint) continue;
        const amt = info?.tokenAmount;
        if (amt?.amount) raw += BigInt(amt.amount);
        if (Number.isInteger(amt?.decimals)) this.decimals.set(mint, amt.decimals);
      }
      return raw;
    };
    const r = await this.rpc('getTokenAccountsByOwner', [this.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const raw = sum(r, false);
    if (raw > 0n) return raw;
    // Nothing found by mint: also look through every token account of both token programs.
    // Newer pump.fun coins are Token-2022 tokens and some RPC providers miss them in the
    // mint-filtered lookup — that made held tokens look "gone" and blocked their sells.
    let total = 0n;
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      try {
        const all = await this.rpc('getTokenAccountsByOwner', [this.address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        total += sum(all, true);
      } catch {
        // try the other program
      }
    }
    return total;
  }

  async refreshBalance() {
    if (!this.ready()) return null;
    const [solR, usdcRaw] = await Promise.all([this.rpc('getBalance', [this.address, { commitment: 'confirmed' }]), this.getTokenBalanceRaw(USDC_MINT).catch(() => 0n)]);
    this.balance = { sol: Number(solR?.value ?? solR ?? 0) / LAMPORTS, usdc: Number(usdcRaw) / 1e6, at: this.now() };
    return this.balance;
  }

  // ---------- Jupiter ----------

  async jup(pathname, { method = 'GET', query = null, body = null, timeoutMs = 15_000 } = {}) {
    const url = new URL(`${this.jupBase}${pathname}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(url.toString(), {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.jupKey ? { 'x-api-key': this.jupKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const err = new Error(`Jupiter ${pathname} HTTP ${res.status}${json?.error || json?.errorMessage ? `: ${json.error || json.errorMessage}` : ''}`);
        err.httpStatus = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`Jupiter ${pathname} timed out`);
        e.timeout = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async order({ inputMint, outputMint, amountRaw, slippagePct }) {
    const query = { inputMint, outputMint, amount: amountRaw.toString(), taker: this.address };
    if (Number.isFinite(slippagePct) && slippagePct > 0) query.slippageBps = Math.round(slippagePct * 100);
    const o = await this.jup('/order', { query });
    if (!o || !o.transaction) {
      throw new Error(o?.errorMessage ? `Jupiter: ${o.errorMessage}${o.errorCode ? ` (code ${o.errorCode})` : ''}` : 'Jupiter returned no route for this token');
    }
    return { ...o, fetchedAt: this.now() };
  }

  // ---------- engine hooks ----------

  /** Hooks for ChainExecutionAdapter.liveHooks */
  hooks() {
    return {
      getSwapQuote: (args) => this.quote(args),
      executeSwap: (args) => this.execute(args),
    };
  }

  quoteAssetMint(assetMode) {
    return assetMode === 'stable' ? USDC_MINT : WSOL_MINT;
  }

  async quote({ side, token, amountUsd, slippagePct, tokenAmount, assetMode = 'native' }) {
    if (!this.ready()) throw new Error(this.keyError || 'real trading is not set up (ODEX_TRADER_KEY missing)');
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) throw new Error('SOL price not known yet');
    const quoteMint = this.quoteAssetMint(assetMode);
    const marketPx = Number(token.currentPriceUsd) || 0;
    const t0 = this.now();
    let order;
    let quotedPriceUsd;
    let tokDec;
    if (side === 'buy') {
      const amountRaw = quoteMint === WSOL_MINT ? BigInt(Math.floor((amountUsd / px) * LAMPORTS)) : BigInt(Math.floor(amountUsd * 1e6));
      // copy speed: the wallet balance and a brand-new coin's decimals (one RPC call each) are
      // read while Jupiter quotes, so the buy's balance check does not wait for them later
      this.prefetchedBalance = { at: this.now(), promise: this.refreshBalance().catch(() => null) };
      [tokDec, order] = await Promise.all([this.getDecimals(token.address), this.order({ inputMint: quoteMint, outputMint: token.address, amountRaw, slippagePct })]);
      const tokensOut = Number(order.outAmount) / 10 ** tokDec;
      quotedPriceUsd = tokensOut > 0 ? amountUsd / tokensOut : 0;
    } else {
      const until = this.sellBlockedUntil.get(token.address) || 0;
      if (this.now() < until) throw Object.assign(new Error(`waiting ${Math.ceil((until - this.now()) / 1000)} s before retrying this sell`), { backoff: true });
      tokDec = await this.getDecimals(token.address);
      const raw = await this.sellAmountRaw(token.address, tokenAmount, tokDec);
      order = await this.order({ inputMint: token.address, outputMint: quoteMint, amountRaw: raw, slippagePct });
      const outUsd = quoteMint === WSOL_MINT ? (Number(order.outAmount) / LAMPORTS) * px : Number(order.outAmount) / 1e6;
      const tokens = Number(raw) / 10 ** tokDec;
      quotedPriceUsd = tokens > 0 ? outUsd / tokens : 0;
    }
    if (!(quotedPriceUsd > 0)) throw new Error('Jupiter quote has no output');
    const ref = marketPx > 0 ? marketPx : quotedPriceUsd;
    // all-in cost vs the market price (route fees + price impact)
    const priceImpactPct = Math.max(0, side === 'buy' ? (quotedPriceUsd / ref - 1) * 100 : (1 - quotedPriceUsd / ref) * 100);
    return {
      quotedPriceUsd,
      expectedFillPriceUsd: quotedPriceUsd,
      priceImpactPct: Math.min(99, priceImpactPct),
      liquidityUsd: Number(token.liquidityUsd) || null,
      maxAllowedSlippagePct: slippagePct,
      timestamp: this.now(),
      real: true,
      _order: order,
      _slippagePct: slippagePct,
      _side: side,
      _quoteMs: this.now() - t0,
    };
  }

  /** How many raw tokens to sell: never more than the wallet holds. */
  async sellAmountRaw(mint, tokenAmount, decimals) {
    const held = await this.getTokenBalanceRaw(mint);
    if (held <= 0n) throw Object.assign(new Error('the bot wallet holds none of this token'), { noTokens: true });
    if (tokenAmount === 'all') return held;
    const want = BigInt(Math.floor(Number(tokenAmount) * 10 ** decimals));
    // never turn a tiny partial sell into "sell everything" (other positions may share this wallet balance)
    if (want <= 0n) throw new Error('sell amount is too small');
    return want > held ? held : want;
  }

  fail(error, extra = {}) {
    this.lastError = { at: this.now(), error };
    return { ok: false, error, paper: false, ...extra };
  }

  record(entry) {
    this.trades.unshift({ t: this.now(), ...entry });
    if (this.trades.length > 300) this.trades.length = 300;
    try {
      this.onChange();
    } catch {
      // saving is best-effort
    }
  }

  async execute({ side, token, amountUsd, quote, slippagePct, tokenAmount, assetMode = 'native' }) {
    if (!this.ready()) return this.fail(this.keyError || 'real trading is not set up (ODEX_TRADER_KEY missing)');
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) return this.fail('SOL price not known yet');
    const mint = token.address;
    const quoteMint = this.quoteAssetMint(assetMode);

    if (side === 'sell') {
      const until = this.sellBlockedUntil.get(mint) || 0;
      if (this.now() < until) return this.fail(`waiting ${Math.ceil((until - this.now()) / 1000)} s before retrying this sell`, { backoff: true });
    }

    // ----- buy limits -----
    let solIn = 0;
    let reserved = null; // this buy's entry in the daily-cap log
    let pendingAdded = 0; // this buy's SOL counted as "in progress"
    // a buy that never went out gives its daily-cap room back
    const release = (result) => {
      if (reserved) this.spendLog = this.spendLog.filter((x) => x !== reserved);
      reserved = null;
      return result;
    };
    try {
    if (side === 'buy') {
      solIn = amountUsd / px;
      if (this.caps.maxSolPerTrade > 0 && solIn > this.caps.maxSolPerTrade + 1e-9) {
        return this.fail(`buy of ${solIn.toFixed(4)} SOL is over the ${this.caps.maxSolPerTrade} SOL per-trade limit`);
      }
      const spent = this.spent24hSol();
      if (this.caps.maxSolPerDay > 0 && spent + solIn > this.caps.maxSolPerDay + 1e-9) {
        return this.fail(`daily limit reached: ${spent.toFixed(3)} of ${this.caps.maxSolPerDay} SOL spent in the last 24 h`);
      }
      // Count the buy against the daily cap right away, before any await: two buys running at
      // the same time could otherwise both pass the check and go over the cap together.
      reserved = { t: this.now(), sol: solIn };
      this.spendLog.push(reserved);
      // SOL already promised to other buys still in progress is not spendable. This buy's own SOL
      // is promised BEFORE any await, so two buys at the same moment can never both pass.
      const pendingSol = quoteMint === WSOL_MINT ? this.pendingBuySol : 0;
      if (quoteMint === WSOL_MINT) {
        pendingAdded = solIn;
        this.pendingBuySol += solIn;
      }
      try {
        const needSol = (quoteMint === WSOL_MINT ? solIn : 0) + pendingSol + this.caps.reserveSol;
        // Copy speed: the balance was read while Jupiter quoted (no extra wait). It is used only
        // if it is fresh and no other buy finished since (that buy's SOL could still be in it).
        const pre = this.prefetchedBalance;
        this.prefetchedBalance = null;
        const usable = pre && this.now() - pre.at < 5000 && pre.at > this.lastBuyDoneAt;
        const bal = (usable && (await pre.promise)) || (await this.refreshBalance());
        if (bal.sol < needSol) return release(this.fail(`not enough SOL: wallet has ${bal.sol.toFixed(4)}, needs ${needSol.toFixed(4)} (incl. ${this.caps.reserveSol} SOL kept for fees${pendingSol > 0 ? `, ${pendingSol.toFixed(4)} SOL for buys in progress` : ''})`));
        if (quoteMint === USDC_MINT && bal.usdc < amountUsd) return release(this.fail(`not enough USDC: wallet has ${bal.usdc.toFixed(2)}`));
      } catch (err) {
        return release(this.fail(`could not read wallet balance: ${err.message}`));
      }
    }

    // ----- order (reuse the quote's if it is fresh and for the same slippage) -----
    let order = quote?._order;
    const fresh = order && quote._side === side && quote._slippagePct === slippagePct && this.now() - order.fetchedAt < 8000;
    let quoteMs = fresh ? quote._quoteMs ?? null : null;
    try {
      if (!fresh) {
        const q = await this.quote({ side, token, amountUsd, slippagePct, tokenAmount, assetMode });
        order = q._order;
        quoteMs = q._quoteMs ?? null;
      }
    } catch (err) {
      if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + this.caps.sellRetrySec * 1000);
      // keep the reason flags: the engine pauses exits when the tokens are gone from the wallet
      return release(this.fail(err.message, { backoff: Boolean(err.backoff), noTokens: Boolean(err.noTokens) }));
    }

    let signed;
    try {
      signed = signTransactionBase64(order.transaction, this.keypair);
    } catch (err) {
      return release(this.fail(`signing failed: ${err.message}`));
    }
    // from here on the buy may reach the chain: it stays counted against the daily cap unless
    // it is known not to have landed (a lost response must not reopen the cap)

    let exec = null;
    let execErr = null;
    const sendStart = this.now();
    try {
      exec = await this.jup('/execute', { method: 'POST', body: { signedTransaction: signed.signedBase64, requestId: order.requestId }, timeoutMs: 45_000 });
    } catch (err) {
      execErr = err;
    }

    // copy speed, measured: Jupiter quote time and send → landed time
    const timing = { quoteMs, sendMs: this.now() - sendStart };
    let landed = exec && (exec.status === 'Success' || Number(exec.code) === 0);
    const signature = exec?.signature || signed.signature;
    if (!exec || (!landed && execErr)) {
      // response lost: look the transaction up on-chain before deciding
      const st = await this.waitForSignature(signature, 30_000);
      landed = st === 'success';
      if (st === 'unknown') {
        this.record({ side, mint, symbol: token.symbol, signature, ok: null, error: `result unknown: ${execErr?.message || 'no response'}` });
        if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + 30_000);
        return this.fail(`swap result unknown (${execErr?.message || 'no response'}). Check the wallet on Solscan: ${signature}`, { unknown: true, txHash: signature });
      }
    }
    if (!landed) {
      release(); // a swap that did not land does not use up the daily cap
      if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + this.caps.sellRetrySec * 1000);
      const why = exec?.error || (exec?.code !== undefined ? `Jupiter code ${exec.code}` : execErr?.message || 'swap failed');
      this.record({ side, mint, symbol: token.symbol, signature, ok: false, error: why });
      return this.fail(`swap did not go through: ${why}`, { txHash: exec?.signature || null });
    }
    this.sellBlockedUntil.delete(mint);

    // ----- exact amounts -----
    const tokDec = await this.getDecimals(mint).catch(() => null);
    let fill;
    try {
      fill = await this.readFill({ signature, side, mint, quoteMint, exec, order, tokDec });
    } catch (err) {
      // The swap DID land: never report it as failed (that would leave untracked tokens in the
      // wallet). Book it from the quote and say the numbers are estimated.
      const big = (v) => {
        try {
          return BigInt(String(v));
        } catch {
          return null;
        }
      };
      const inputRaw = big(exec?.totalInputAmount) ?? big(order.inAmount);
      const outputRaw = big(exec?.totalOutputAmount) ?? big(order.outAmount);
      const dec = tokDec ?? this.decimals.get(mint);
      if (inputRaw === null || outputRaw === null || dec === undefined || dec === null) {
        this.record({ side, mint, symbol: token.symbol, signature, ok: true, error: `landed, amounts unreadable: ${err.message}` });
        return this.fail(`swap landed but its amounts could not be read — check the wallet: ${signature}`, { unknown: true, landed: true, txHash: signature });
      }
      fill = { inputRaw, outputRaw, inputFeeRaw: 0n, outputFeeRaw: 0n, networkLamports: 5000, tokDec: dec, estimated: true };
    }
    const quoteUsd = (raw) => (quoteMint === WSOL_MINT ? (Number(raw) / LAMPORTS) * px : Number(raw) / 1e6);
    const networkFeeUsd = (fill.networkLamports / LAMPORTS) * px;
    let result;
    if (side === 'buy') {
      const spentUsd = quoteUsd(fill.inputRaw);
      const tokens = Number(fill.outputRaw) / 10 ** fill.tokDec;
      const routeFeeUsd = fill.inputFeeRaw > 0n ? quoteUsd(fill.inputFeeRaw) : 0;
      result = {
        ok: true,
        paper: false,
        txHash: signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        tokensReceived: tokens,
        spentUsd,
        platformFeeUsd: routeFeeUsd,
        networkFeeUsd,
        fillPriceUsd: tokens > 0 ? (spentUsd - routeFeeUsd) / tokens : quote?.expectedFillPriceUsd || 0,
        router: order.router || null,
        executedAt: this.now(),
      };
      // replace the reserved cap amount with what was really spent
      reserved.sol = quoteMint === WSOL_MINT ? Number(fill.inputRaw) / LAMPORTS : spentUsd / px;
    } else {
      const tokensSold = Number(fill.inputRaw) / 10 ** fill.tokDec;
      const receivedUsd = quoteUsd(fill.outputRaw); // what reached the wallet (before the network fee)
      const routeFeeUsd = fill.outputFeeRaw > 0n ? quoteUsd(fill.outputFeeRaw) : 0;
      result = {
        ok: true,
        paper: false,
        txHash: signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        tokensSold,
        receivedUsd,
        platformFeeUsd: routeFeeUsd,
        networkFeeUsd,
        // engine: gross − platform fee − network fee = what the wallet really gained
        fillPriceUsd: tokensSold > 0 ? (receivedUsd + routeFeeUsd) / tokensSold : 0,
        router: order.router || null,
        executedAt: this.now(),
      };
    }
    if (fill.estimated) result.estimated = true;
    result.timing = timing;
    this.record({ side, mint, symbol: token.symbol, signature, ok: true, timing, estimated: Boolean(fill.estimated), usd: Number((side === 'buy' ? result.spentUsd : result.receivedUsd).toFixed(4)), networkFeeUsd: Number(networkFeeUsd.toFixed(4)) });
    this.refreshBalance().catch(() => {});
    return result;
    } finally {
      if (pendingAdded) {
        this.lastBuyDoneAt = this.now();
        this.pendingBuySol -= pendingAdded;
        if (this.pendingBuySol < 1e-9) this.pendingBuySol = 0; // no float leftovers
      }
    }
  }

  /** Poll signature status: 'success' | 'failed' | 'unknown'. */
  async waitForSignature(signature, maxMs) {
    const until = this.now() + maxMs;
    while (this.now() < until) {
      try {
        const r = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
        const st = r?.value?.[0];
        if (st) {
          if (st.err) return 'failed';
          if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'success';
        }
      } catch {
        // keep trying
      }
      await this.sleep(1500);
    }
    return 'unknown';
  }

  /**
   * Exact amounts: Jupiter's execute result where present, the on-chain transaction for the
   * network fee (fee + priority + new token-account rent).
   */
  async readFill({ signature, side, mint, quoteMint, exec, order, tokDec }) {
    const big = (v) => {
      try {
        return v === undefined || v === null || v === '' ? null : BigInt(String(v));
      } catch {
        return null;
      }
    };
    let inputRaw = big(exec?.totalInputAmount) ?? big(exec?.inputAmountResult) ?? big(order.inAmount);
    let outputRaw = big(exec?.totalOutputAmount) ?? big(exec?.outputAmountResult);
    const inputFeeRaw = big(exec?.totalInputAmount) !== null && big(exec?.inputAmountResult) !== null ? big(exec.totalInputAmount) - big(exec.inputAmountResult) : 0n;
    const outputFeeRaw = big(exec?.outputAmountResult) !== null && big(exec?.totalOutputAmount) !== null ? big(exec.outputAmountResult) - big(exec.totalOutputAmount) : 0n;
    let networkLamports = 5000;
    let decimals = tokDec;
    let tx = null;
    for (let i = 0; i < 6 && !tx; i++) {
      try {
        tx = await this.rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      } catch {
        tx = null;
      }
      if (!tx) await this.sleep(1000);
    }
    if (tx?.meta) {
      const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      const me = keys.indexOf(this.address);
      const solDelta = me >= 0 ? BigInt(tx.meta.postBalances[me]) - BigInt(tx.meta.preBalances[me]) : null; // lamports
      const tokDelta = (m) => {
        let pre = 0n;
        let post = 0n;
        for (const b of tx.meta.preTokenBalances || []) if (b.owner === this.address && b.mint === m) {
          pre += BigInt(b.uiTokenAmount.amount);
          decimals = m === mint ? b.uiTokenAmount.decimals : decimals;
        }
        for (const b of tx.meta.postTokenBalances || []) if (b.owner === this.address && b.mint === m) {
          post += BigInt(b.uiTokenAmount.amount);
          decimals = m === mint ? b.uiTokenAmount.decimals : decimals;
        }
        return post - pre;
      };
      const tDelta = tokDelta(mint);
      if (side === 'buy') {
        if (tDelta > 0n) outputRaw = tDelta;
        if (quoteMint === WSOL_MINT && solDelta !== null) {
          const spent = -solDelta; // swap input + fees + rent
          if (inputRaw === null) inputRaw = spent;
          networkLamports = Number(spent - inputRaw);
        } else networkLamports = Number(tx.meta.fee || 5000);
      } else {
        if (tDelta < 0n) inputRaw = -tDelta;
        if (quoteMint === WSOL_MINT && solDelta !== null) {
          if (outputRaw === null) outputRaw = solDelta + BigInt(tx.meta.fee || 5000);
          networkLamports = Number(outputRaw - solDelta);
        } else networkLamports = Number(tx.meta.fee || 5000);
      }
      if (!(networkLamports >= 0)) networkLamports = Number(tx.meta.fee || 5000);
    }
    if (decimals === null || decimals === undefined) decimals = await this.getDecimals(mint);
    if (inputRaw === null || outputRaw === null) throw new Error('swap landed but amounts could not be read');
    return { inputRaw, outputRaw, inputFeeRaw: inputFeeRaw > 0n ? inputFeeRaw : 0n, outputFeeRaw: outputFeeRaw > 0n ? outputFeeRaw : 0n, networkLamports, tokDec: decimals };
  }

  /**
   * Safe end-to-end check that sends nothing: builds a tiny SOL→USDC order for the bot wallet,
   * signs it and asks the RPC to simulate it with signature verification.
   */
  async selfTest() {
    if (!this.ready()) return { ok: false, error: this.keyError || 'ODEX_TRADER_KEY is not set in .env' };
    const steps = [];
    try {
      const probe = crypto.randomBytes(32);
      if (!this.keypair.verify(probe, this.keypair.sign(probe))) throw new Error('key cannot produce valid signatures');
      steps.push(`key loaded and signs correctly (wallet ${this.address})`);
      const bal = await this.refreshBalance();
      steps.push(`balance: ${bal.sol.toFixed(4)} SOL, ${bal.usdc.toFixed(2)} USDC`);
      if (bal.sol < 0.003) {
        steps.push('wallet needs SOL before a swap can be simulated — send some SOL to it, then run the test again');
        return { ok: true, steps, warning: 'Key works. Fund the wallet to finish the test.' };
      }
      const lamports = 1_000_000n; // 0.001 SOL
      const o = await this.order({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amountRaw: lamports, slippagePct: 1 });
      steps.push(`Jupiter route ok (${o.router || 'route'}), 0.001 SOL → ${(Number(o.outAmount) / 1e6).toFixed(4)} USDC`);
      const s = signTransactionBase64(o.transaction, this.keypair);
      steps.push('transaction signed with the bot key');
      const sim = await this.rpc('simulateTransaction', [s.signedBase64, { encoding: 'base64', sigVerify: true, commitment: 'processed' }]);
      const err = sim?.value?.err;
      if (err) {
        steps.push(`simulation failed: ${JSON.stringify(err)}`);
        return { ok: false, steps, error: `simulation failed: ${JSON.stringify(err)}` };
      }
      steps.push('simulation passed (signature valid, swap would succeed) — nothing was sent');
      return { ok: true, steps };
    } catch (err) {
      steps.push(`error: ${err.message}`);
      return { ok: false, steps, error: err.message };
    }
  }
}

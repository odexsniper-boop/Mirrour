/**
 * Token-account stream — the fastest spam-proof way to see a wallet's buys and sells.
 *
 * Spam-flooded wallets get thousands of junk transactions, so watching their transactions (or
 * their SOL balance and then searching the junk) is slow. Their TOKEN ACCOUNTS are never touched
 * by spam, but every real buy or sell changes one — including the brand-new account created when
 * they buy a new coin. One `programSubscribe` per token program, filtered on owner = the wallet,
 * pushes every such change the moment it lands (mint + new amount included).
 *
 * The caller then reads the latest transaction of that token account (it has almost none, so this
 * is one quick call) and handles it like any other trade.
 *
 * Zero dependencies: Node 22's built-in WebSocket.
 */
import { base58Encode } from './onchainMeta.mjs';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PXnBqCXEpPxuEb';

/** Decode a token account's base64 data: mint (0–32), owner (32–64), amount u64 LE (64–72). */
export function decodeTokenAccount(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 72) return null;
  return {
    mint: base58Encode(buf.subarray(0, 32)),
    owner: base58Encode(buf.subarray(32, 64)),
    amount: buf.readBigUInt64LE(64),
  };
}

export class TokenAccountStream {
  constructor({ url = null, WebSocketImpl = globalThis.WebSocket, onChange = () => {}, onStatus = () => {}, redactUrl = (s) => s, commitment = process.env.ODEX_STREAM_COMMITMENT || 'processed', keepaliveMs = 30_000, maxBackoffMs = 30_000 } = {}) {
    this.url = url;
    this.WS = WebSocketImpl;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.redactUrl = redactUrl;
    this.commitment = commitment;
    this.keepaliveMs = keepaliveMs;
    this.maxBackoffMs = maxBackoffMs;
    this.wallets = new Set();
    this.ws = null;
    this.running = false;
    this.nextId = 1;
    this.pending = new Map(); // request id → { wallet, program }
    this.subs = new Map(); // subscription id → { wallet, program }
    this.backoffMs = 1000;
    this.timers = { reconnect: null, keepalive: null };
    this.lastAmount = new Map(); // token account → amount (to tell buys from sells)
    this.stats = { connected: false, connectedAt: null, events: 0, lastEventAt: null, reconnects: 0, lastError: null, lastErrorAt: null };
  }

  get supported() {
    return typeof this.WS === 'function' && Boolean(this.url);
  }

  status() {
    return { enabled: this.running, supported: this.supported, connected: this.stats.connected, subscriptions: this.subs.size, wallets: this.wallets.size, events: this.stats.events, lastEventAt: this.stats.lastEventAt, reconnects: this.stats.reconnects, lastError: this.stats.lastError, lastErrorAt: this.stats.lastErrorAt };
  }

  emitStatus() {
    try {
      this.onStatus(this.status());
    } catch {
      // ignore
    }
  }

  setWallets(addresses) {
    const next = new Set(addresses);
    const same = next.size === this.wallets.size && [...next].every((a) => this.wallets.has(a));
    this.wallets = next;
    if (!same && this.running) this.reconnectNow();
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    if (this.running) this.reconnectNow();
  }

  start() {
    if (this.running || !this.supported) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timers.reconnect);
    clearInterval(this.timers.keepalive);
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.stats.connected = false;
    this.emitStatus();
  }

  reconnectNow() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  fail(msg) {
    this.stats.lastError = this.redactUrl(String(msg || 'token stream error')).slice(0, 200);
    this.stats.lastErrorAt = Date.now();
  }

  send(obj, meta) {
    const id = this.nextId++;
    if (meta) this.pending.set(id, meta);
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...obj }));
    } catch (err) {
      this.fail(err.message);
    }
    return id;
  }

  subscribeAll() {
    this.subs.clear();
    this.pending.clear();
    for (const wallet of this.wallets) {
      for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
        const filters = [{ memcmp: { offset: 32, bytes: wallet } }];
        if (program === TOKEN_PROGRAM) filters.push({ dataSize: 165 });
        this.send({ method: 'programSubscribe', params: [program, { encoding: 'base64', commitment: this.commitment, filters }] }, { wallet, program });
      }
    }
  }

  connect() {
    if (!this.running || !this.supported) return;
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.fail(err.message);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.stats.connected = true;
      this.stats.connectedAt = Date.now();
      this.backoffMs = 1000;
      this.subscribeAll();
      clearInterval(this.timers.keepalive);
      // a harmless request keeps idle connections from being closed by the provider
      this.timers.keepalive = setInterval(() => {
        if (this.ws === ws && ws.readyState === 1) this.send({ method: 'slotUnsubscribe', params: [0] });
      }, this.keepaliveMs);
      this.emitStatus();
    };
    ws.onmessage = (evt) => this.handleMessage(evt.data);
    ws.onerror = () => this.fail('token stream connection error');
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.connected = false;
      clearInterval(this.timers.keepalive);
      this.emitStatus();
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (!this.running) return;
    clearTimeout(this.timers.reconnect);
    this.stats.reconnects += 1;
    this.timers.reconnect = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const meta = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) this.fail(`subscribe failed: ${msg.error.message || 'error'}`);
      else if (typeof msg.result === 'number') this.subs.set(msg.result, meta);
      this.emitStatus();
      return;
    }
    if (msg.method !== 'programNotification') return;
    const meta = this.subs.get(msg.params?.subscription);
    const value = msg.params?.result?.value;
    if (!meta || !value?.pubkey) return;
    const data = Array.isArray(value.account?.data) ? value.account.data[0] : null;
    let acc = decodeTokenAccount(data);
    // a token account closed after selling everything arrives empty: still a (sell) change
    if (!acc && this.lastAmount.has(value.pubkey)) acc = { mint: null, owner: meta.wallet, amount: 0n, closed: true };
    if (!acc || acc.owner !== meta.wallet) return;
    const prev = this.lastAmount.get(value.pubkey);
    this.lastAmount.set(value.pubkey, acc.amount);
    if (this.lastAmount.size > 5000) this.lastAmount = new Map([...this.lastAmount].slice(-2500));
    this.stats.events += 1;
    this.stats.lastEventAt = Date.now();
    try {
      this.onChange({ wallet: meta.wallet, tokenAccount: value.pubkey, mint: acc.mint, amount: acc.amount, prevAmount: prev ?? null, slot: msg.params?.result?.context?.slot ?? null, receivedAt: Date.now() });
    } catch {
      // ignore listener errors
    }
  }
}

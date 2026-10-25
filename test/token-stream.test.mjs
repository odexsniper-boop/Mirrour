// Token-account stream: spam-proof buy/sell detection via programSubscribe on the token programs.
// Run: node --test test/token-stream.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TokenAccountStream, decodeTokenAccount, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../engine/tokenStream.mjs';
import { SolanaWalletWatcher } from '../engine/walletWatcher.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';

const WALLET = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const rnd = () => base58Encode(crypto.randomBytes(32));
function tokenData(mint, owner, amount) {
  const b = Buffer.alloc(165);
  Buffer.from(Buffer.from(require58(mint))).copy(b, 0);
  Buffer.from(require58(owner)).copy(b, 32);
  b.writeBigUInt64LE(BigInt(amount), 64);
  return b.toString('base64');
}
import { base58Decode } from '../engine/onchainMeta.mjs';
function require58(s) { return base58Decode(s); }

class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('decodes mint, owner and amount from token account data', () => {
  const mint = rnd();
  const d = decodeTokenAccount(tokenData(mint, WALLET, 123456789));
  assert.equal(d.mint, mint);
  assert.equal(d.owner, WALLET);
  assert.equal(d.amount, 123456789n);
  assert.equal(decodeTokenAccount(''), null);
});

test('subscribes to both token programs filtered on the wallet, and reports buys, sells and closed accounts', async () => {
  const changes = [];
  const s = new TokenAccountStream({ url: 'wss://x', WebSocketImpl: FakeWS, onChange: (e) => changes.push(e) });
  s.setWallets([WALLET]);
  s.start();
  await wait(5);
  const ws = FakeWS.last;
  const subs = ws.sent.filter((m) => m.method === 'programSubscribe');
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((m) => m.params[0]).sort(), [TOKEN_2022_PROGRAM, TOKEN_PROGRAM].sort());
  assert.ok(subs.every((m) => m.params[1].filters.some((f) => f.memcmp?.offset === 32 && f.memcmp.bytes === WALLET)));
  ws.push({ id: subs[0].id, result: 11 });
  ws.push({ id: subs[1].id, result: 12 });
  const mint = rnd();
  const ta = rnd();
  ws.push({ method: 'programNotification', params: { subscription: 11, result: { context: { slot: 5 }, value: { pubkey: ta, account: { data: [tokenData(mint, WALLET, 1000), 'base64'] } } } } });
  ws.push({ method: 'programNotification', params: { subscription: 11, result: { context: { slot: 6 }, value: { pubkey: ta, account: { data: [tokenData(mint, WALLET, 400), 'base64'] } } } } });
  ws.push({ method: 'programNotification', params: { subscription: 11, result: { context: { slot: 7 }, value: { pubkey: ta, account: { data: ['', 'base64'] } } } } });
  // someone else's account never counts
  ws.push({ method: 'programNotification', params: { subscription: 11, result: { context: { slot: 8 }, value: { pubkey: rnd(), account: { data: [tokenData(mint, rnd(), 5), 'base64'] } } } } });
  assert.equal(changes.length, 3);
  assert.equal(changes[0].amount, 1000n);
  assert.equal(changes[0].prevAmount, null);
  assert.equal(changes[1].amount, 400n);
  assert.equal(changes[1].prevAmount, 1000n);
  assert.equal(changes[2].amount, 0n, 'closed account = sold everything');
  s.stop();
});

test('watcher: a token-account change reads that account’s newest fresh trade and handles it once (oldest first)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const calls = [];
  const w = new SolanaWalletWatcher({ rpcUrl: 'https://x', stream: false, tokenStreamUrl: null });
  w.wallets.set(WALLET, { address: WALLET, label: 'decu', mode: 'balances' });
  w.rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') return [
      { signature: 'new2', blockTime: now, err: null },
      { signature: 'new1', blockTime: now - 2, err: null },
      { signature: 'failed', blockTime: now, err: { x: 1 } },
      { signature: 'old', blockTime: now - 3600, err: null },
    ];
    throw new Error('unexpected ' + method);
  };
  w.processSignature = async (wal, sig, opts) => { calls.push([sig, opts.via]); w.seenSigs.add(sig); return { signature: sig }; };
  await w.handleTokenChange({ wallet: WALLET, tokenAccount: rnd(), receivedAt: Date.now() });
  assert.deepEqual(calls, [['new1', 'token-stream'], ['new2', 'token-stream']], 'fresh, successful, oldest first; no old history');
  await w.handleTokenChange({ wallet: WALLET, tokenAccount: rnd(), receivedAt: Date.now() });
  assert.equal(calls.length, 2, 'already-seen trades are not handled twice');
});

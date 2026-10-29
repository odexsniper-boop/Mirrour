// Bot Wallet → Send: SOL transfer checks, simulation gate and limits (offline, mock RPC).
// Run: node --test test/bot-send.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RealTrader } from '../engine/realTrader.mjs';
import { base58Encode, base58Decode } from '../engine/onchainMeta.mjs';
import * as PD from '../engine/pumpDirect.mjs';

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), address: base58Encode(pub) };
}
/** Parse the System transfer out of a legacy tx: { to, lamports }. */
function parseTransfer(b64) {
  const tx = Buffer.from(b64, 'base64');
  const m = tx.subarray(1 + 64 * tx[0]);
  const n = m[3];
  const keys = Array.from({ length: n }, (_, i) => base58Encode(m.subarray(4 + 32 * i, 36 + 32 * i)));
  let o = 4 + 32 * n + 32;
  const nIx = m[o++];
  for (let i = 0; i < nIx; i++) {
    const prog = keys[m[o++]];
    const na = m[o++];
    const accs = [...m.subarray(o, o + na)].map((k) => keys[k]);
    o += na;
    const dl = m[o++];
    const data = m.subarray(o, o + dl);
    o += dl;
    if (prog === PD.SYSTEM_PROGRAM) return { from: accs[0], to: accs[1], lamports: data.readBigUInt64LE(4), tag: data.readUInt32LE(0) };
  }
  return null;
}

function world({ sol = 1, destExists = true, destOwner = PD.SYSTEM_PROGRAM, lie = false, confirm = 'success' } = {}) {
  const k = newKey();
  const dest = newKey().address;
  const w = { lamports: BigInt(Math.round(sol * 1e9)), dest: destExists ? 5_000_000n : 0n, sent: [], sims: 0 };
  const rpc = async (method, params) => {
    if (method === 'getBalance') return { value: Number(w.lamports) };
    if (method === 'getAccountInfo') return { value: destExists ? { owner: destOwner, lamports: Number(w.dest), executable: false } : null };
    if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
    if (method === 'simulateTransaction') {
      w.sims++;
      const t = parseTransfer(params[0]);
      assert.equal(params[1].sigVerify, true);
      const moved = lie ? t.lamports + 1n : t.lamports;
      return { value: { err: null, accounts: [{ lamports: Number(w.lamports - t.lamports - 5100n) }, { lamports: Number(w.dest + moved) }] } };
    }
    if (method === 'sendTransaction') {
      w.sent.push(parseTransfer(params[0]));
      return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
    }
    if (method === 'getSignatureStatuses') return { value: [confirm === 'unknown' ? null : { confirmationStatus: 'confirmed', err: confirm === 'failed' ? { InstructionError: [0, 'x'] } : null }] };
    if (method === 'getTokenAccountsByOwner') return { value: [] };
    return null;
  };
  let t = 1_000_000;
  const trader = new RealTrader({ env: { ODEX_TRADER_KEY: k.secret, ODEX_REAL_RESERVE_SOL: '0.02' }, rpc, solPrice: () => 200, fetchImpl: async () => ({ ok: false, status: 500, text: async () => '{}' }), sleep: async () => { t += 500; }, now: () => t });
  trader.blastSignedTransaction = () => {};
  return { trader, w, dest, me: k.address };
}

test('BS1 a normal send: tested first, then exactly that amount goes to that address', async () => {
  const { trader, w, dest, me } = world();
  const r = await trader.sendSol({ to: dest, amountSol: 0.25 });
  assert.equal(r.ok, true, r.error);
  assert.equal(w.sims, 1);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0], { from: me, to: dest, lamports: 250_000_000n, tag: 2 });
  assert.equal(r.sentSol, 0.25);
  assert.equal(trader.trades[0].side, 'transfer');
  assert.equal(trader.spent24hSol(), 0, 'a transfer is not counted as trading spend');
});

test('BS2 bad recipients are refused before anything is built or sent', async () => {
  const { trader, w, me } = world();
  for (const [to, re] of [
    ['not-an-address', /not a valid/],
    [me, /bot wallet itself/],
    [PD.bondingCurveAddress(newKey().address), /belongs to a program/],
  ]) {
    const r = await trader.sendSol({ to, amountSol: 0.1 });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  }
  const tok = world({ destOwner: PD.TOKEN_PROGRAM });
  const r = await tok.trader.sendSol({ to: tok.dest, amountSol: 0.1 });
  assert.match(r.error, /token account or program/);
  assert.equal(w.sims + tok.w.sims, 0);
  assert.equal(w.sent.length + tok.w.sent.length, 0);
});

test('BS3 amounts: too much refused; Max sends all but the fee; reserve kept while real positions are open', async () => {
  {
    const { trader, w, dest } = world({ sol: 0.5 });
    const r = await trader.sendSol({ to: dest, amountSol: 0.6 });
    assert.match(r.error, /not enough SOL/);
    assert.equal(w.sent.length, 0);
  }
  {
    const { trader, w, dest } = world({ sol: 0.5 });
    const r = await trader.sendSol({ to: dest, amountSol: 'max', keepReserve: false });
    assert.equal(r.ok, true, r.error);
    assert.equal(w.sent[0].lamports, 500_000_000n - 5_100n, 'everything minus the network fee');
  }
  {
    const { trader, w, dest } = world({ sol: 0.5 });
    const r = await trader.sendSol({ to: dest, amountSol: 'max', keepReserve: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(w.sent[0].lamports, 500_000_000n - 5_100n - 20_000_000n, '0.02 SOL kept to sell open positions');
    const r2 = await world({ sol: 0.5 }).trader.sendSol({ to: dest, amountSol: 0.49, keepReserve: true });
    assert.match(r2.error, /kept for selling the open positions/);
  }
  {
    const { trader, dest } = world({ sol: 0.5 });
    trader.pendingBuySol = 0.3;
    const r = await trader.sendSol({ to: dest, amountSol: 0.3, keepReserve: false });
    assert.match(r.error, /reserved for buys in progress/);
  }
});

test('BS4 Solana minimums: a new wallet needs 0.00089 SOL; never strand dust behind', async () => {
  const fresh = world({ destExists: false });
  assert.match((await fresh.trader.sendSol({ to: fresh.dest, amountSol: 0.0005 })).error, /new \(empty\) wallet/);
  assert.equal((await fresh.trader.sendSol({ to: fresh.dest, amountSol: 0.001 })).ok, true);
  const dust = world({ sol: 0.1 });
  assert.match((await dust.trader.sendSol({ to: dust.dest, amountSol: 0.0995, keepReserve: false })).error, /leave .* below Solana/);
});

test('BS5 test run moving a different amount → nothing sent; dry run sends nothing; unconfirmed is reported', async () => {
  const lie = world({ lie: true });
  const r = await lie.trader.sendSol({ to: lie.dest, amountSol: 0.1 });
  assert.match(r.error, /did not move exactly/);
  assert.equal(lie.w.sent.length, 0);
  const dry = world();
  const d = await dry.trader.sendSol({ to: dry.dest, amountSol: 0.1, dryRun: true });
  assert.equal(d.ok, true);
  assert.equal(d.dryRun, true);
  assert.equal(dry.w.sims, 1);
  assert.equal(dry.w.sent.length, 0);
  const unk = world({ confirm: 'unknown' });
  const u = await unk.trader.sendSol({ to: unk.dest, amountSol: 0.1 });
  assert.equal(u.ok, false);
  assert.equal(u.unknown, true);
  assert.match(u.error, /check Solscan before sending again/);
  const failed = world({ confirm: 'failed' });
  assert.match((await failed.trader.sendSol({ to: failed.dest, amountSol: 0.1 })).error, /failed on-chain/);
});

test('BS6 two sends at once: the second is refused', async () => {
  const { trader, dest } = world();
  const [a, b] = await Promise.all([trader.sendSol({ to: dest, amountSol: 0.1 }), trader.sendSol({ to: dest, amountSol: 0.1 })]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.match([a, b].find((x) => !x.ok).error, /already in progress/);
});

// Close record: a real position whose coins already left the bot wallet (offline, mock RPC).
// Run: node --test test/close-record.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RealTrader } from '../engine/realTrader.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';
import * as PD from '../engine/pumpDirect.mjs';

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), address: base58Encode(pub) };
}
const MINT = base58Encode(crypto.createHash('sha256').update('earny').digest());

function world({ held = 0n } = {}) {
  const k = newKey();
  const ata = PD.ataAddress(k.address, MINT, PD.TOKEN_2022_PROGRAM);
  const now = Math.floor(Date.now() / 1000);
  // newest first: final sell (not booked), initials sell (booked), the buy
  const txs = {
    sellFinal: { t: now - 60, tok: [5_000_000n, 0n], sol: [100_000_000, 210_000_000] },
    sellInitials: { t: now - 300, tok: [10_000_000n, 5_000_000n], sol: [0, 100_000_000] },
    buy: { t: now - 600, tok: [0n, 10_000_000n], sol: [200_000_000, 0] },
  };
  const rpc = async (method, params) => {
    if (method === 'getTokenAccountsByOwner') return { value: held > 0n ? [{ pubkey: ata, account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: String(held), decimals: 6 } } } } } }] : [] };
    if (method === 'getSignaturesForAddress') return params[0] === ata ? Object.entries(txs).map(([sig, x]) => ({ signature: sig, blockTime: x.t, err: null })) : [];
    if (method === 'getTransaction') {
      const x = txs[params[0]];
      const bal = (a) => [{ mint: MINT, owner: k.address, uiTokenAmount: { amount: String(a), decimals: 6 } }];
      return { blockTime: x.t, meta: { err: null, preBalances: [x.sol[0]], postBalances: [x.sol[1]], preTokenBalances: bal(x.tok[0]), postTokenBalances: bal(x.tok[1]) }, transaction: { message: { accountKeys: [{ pubkey: k.address }] } } };
    }
    return null;
  };
  const trader = new RealTrader({ env: { ODEX_TRADER_KEY: k.secret }, rpc, solPrice: () => 200 });
  return { trader, now };
}

test('CR1 coins still in the wallet → nothing is closed', async () => {
  const { trader } = world({ held: 123n });
  const r = await trader.findTokenExit(MINT);
  assert.equal(r.held, 123n);
  assert.equal(r.sale, null);
});

test('CR2 coins gone: the unbooked sale is found; the booked "Initials" sell and the buy are not counted', async () => {
  const { trader, now } = world();
  const r = await trader.findTokenExit(MINT, { skip: new Set(['sellInitials']), since: (now - 700) * 1000 });
  assert.equal(r.held, 0n);
  assert.deepEqual(r.sale.signatures, ['sellFinal']);
  assert.ok(Math.abs(r.sale.receivedSol - 0.11) < 1e-9, `got ${r.sale.receivedSol}`);
  // nothing booked yet → both sells count
  const all = await trader.findTokenExit(MINT, { since: (now - 700) * 1000 });
  assert.deepEqual(all.sale.signatures, ['sellFinal', 'sellInitials']);
  assert.ok(Math.abs(all.sale.receivedSol - 0.21) < 1e-9);
  // exits from before this position opened are ignored
  const later = await trader.findTokenExit(MINT, { since: (now + 10) * 1000 });
  assert.equal(later.sale, null);
});

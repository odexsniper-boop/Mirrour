process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataPda, parseMetadataAccount, base58Decode, base58Encode, OnchainMetadata } from '../engine/onchainMeta.mjs';
import { AlchemyService } from '../engine/alchemy.mjs';

// Real mainnet values (checked on-chain: these accounts exist and are owned by the metadata program)
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_META_B64 = 'BHlZUWfaSAxa4TRFAdIRt3NjQOP73wDs3mO2TciKzC8cvAfFbmCtPT8Xc4LqxlSPuh/TLP2QygKz58+hhf3Oc5ggAAAAQm9uawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAQm9uawAAAAAAAMgAAABodHRwczovL2Fyd2VhdmUubmV0L1FQQzZGWWRVbi0zVjh5dEZOdW9DUzg1UzJ0SEF1aURibGg2dTNDSVpMc3cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAf8BAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('O1 base58 round trip and metadata PDA match mainnet', () => {
  for (const a of [BONK, USDC, '11111111111111111111111111111111']) assert.equal(base58Encode(base58Decode(a)), a);
  assert.equal(metadataPda(BONK), 'FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN');
  assert.equal(metadataPda(USDC), '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq');
});

test('O2 parses a real Metaplex metadata account', () => {
  const m = parseMetadataAccount(BONK_META_B64);
  assert.equal(m.mint, BONK);
  assert.equal(m.name, 'Bonk');
  assert.equal(m.symbol, 'Bonk');
  assert.match(m.uri, /^https:\/\/arweave\.net\//);
});

function fakeRpc(handlers) {
  return async (method, params) => {
    if (!handlers[method]) throw new Error(`unexpected ${method}`);
    return handlers[method](params);
  };
}
const jsonFetch = (map) => async (url) => ({ ok: Boolean(map[url]), text: async () => JSON.stringify(map[url] || {}) });

test('O3 token logo from a Token-2022 mint (new pump.fun tokens) and from a Metaplex account', async () => {
  const meta = new OnchainMetadata({
    rpc: fakeRpc({
      getMultipleAccounts: ([[mint]]) => ({
        value:
          mint === 'GTfKDLH9Ntr9ywFz8ParczjyEbJFj6RBns83h51Hpump'
            ? [{ data: { parsed: { info: { decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'tokenMetadata', state: { name: 'Universal Basic Capital', symbol: 'UBC', uri: 'https://meta.example/ubc.json' } }] } } } }, null]
            : [{ data: { parsed: { info: { decimals: 5 } } } }, { data: [BONK_META_B64, 'base64'] }],
      }),
    }),
    fetchImpl: jsonFetch({ 'https://meta.example/ubc.json': { image: 'ipfs://QmUBC' }, 'https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw': { image: 'https://arweave.net/bonk.png' } }),
  });
  const ubc = await meta.getToken('GTfKDLH9Ntr9ywFz8ParczjyEbJFj6RBns83h51Hpump');
  assert.equal(ubc.symbol, 'UBC');
  assert.equal(ubc.imageUrl, 'https://ipfs.io/ipfs/QmUBC');
  const bonk = await meta.getToken(BONK);
  assert.equal(bonk.name, 'Bonk');
  assert.equal(bonk.imageUrl, 'https://arweave.net/bonk.png');
});

test('O4 when Alchemy DAS returns 503 the on-chain fallback serves logos and DAS is paused', async () => {
  let dasCalls = 0;
  const a = new AlchemyService({ apiKey: 'k_test_1234567890', fetchImpl: async () => { dasCalls += 1; return { ok: false, status: 503, json: async () => ({}) }; } });
  a.retryDelaysMs = [];
  a.fallback = { enabled: true, stats: {}, getToken: async (m) => ({ name: 'T', symbol: 'T', imageUrl: `https://img/${m}.png`, source: 'onchain' }), getWalletAvatar: async () => ({ imageUrl: 'https://img/nft.png', name: 'NFT', source: 'nft' }) };
  for (const m of ['m1', 'm2', 'm3']) assert.equal((await a.getSolanaToken(m)).imageUrl, `https://img/${m}.png`);
  assert.equal(a.status().das.down, true, 'paused after 3 failures');
  const before = dasCalls;
  assert.equal((await a.getSolanaToken('m4')).source, 'onchain');
  assert.equal(dasCalls, before, 'no DAS call while paused');
  assert.equal((await a.getWalletAvatar('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).imageUrl, 'https://img/nft.png');
});

test('O5 wallet picture from on-chain NFTs: verified collection only, spam skipped', async () => {
  const nftMeta = (name, verified) => {
    const b = Buffer.alloc(400);
    let o = 0;
    b[o++] = 4;
    o += 64;
    const w = (s) => { b.writeUInt32LE(Buffer.byteLength(s), o); o += 4; b.write(s, o); o += Buffer.byteLength(s); };
    w(name); w('SYM'); w(`https://meta.example/${encodeURIComponent(name)}.json`);
    o += 2; b[o++] = 0; o += 2; b[o++] = 0; b[o++] = 1; b[o++] = 0; b[o++] = 1; b[o++] = verified ? 1 : 0;
    return b.toString('base64');
  };
  const meta = new OnchainMetadata({
    rpc: fakeRpc({
      getTokenAccountsByOwner: () => ({ value: ['A', 'B', 'C'].map((k, i) => ({ account: { data: { parsed: { info: { mint: [BONK, USDC, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'][i], tokenAmount: { decimals: 0, amount: '1' } } } } } })) }),
      getMultipleAccounts: () => ({ value: [{ data: [nftMeta('Claim 500 SOL at x.xyz', true), 'base64'] }, { data: [nftMeta('Unverified Ape', false), 'base64'] }, { data: [nftMeta('Mad Lad #42', true), 'base64'] }] }),
    }),
    fetchImpl: jsonFetch({ 'https://meta.example/Mad%20Lad%20%2342.json': { image: 'https://img.example/madlad.png' } }),
  });
  const r = await meta.getWalletAvatar('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  assert.equal(r?.imageUrl, 'https://img.example/madlad.png');
  assert.equal(r.name, 'Mad Lad #42');
});

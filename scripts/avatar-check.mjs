import { loadEnvFile } from '../engine/env.mjs';
import { AlchemyService } from '../engine/alchemy.mjs';
try { loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
const a = new AlchemyService({ apiKey: process.env.ALCHEMY_API_KEY });
console.log('alchemy configured:', a.enabled);
const wallets = process.argv.slice(2);
for (const w of wallets) {
  const url = a.solanaRpcUrl();
  try {
    const r = await a.rpc(url, 'getAssetsByOwner', { ownerAddress: w, page: 1, limit: 100, displayOptions: { showFungible: false } });
    const items = r?.items || [];
    const kinds = {};
    for (const i of items) kinds[`${i.interface}${i.compression?.compressed ? '/cNFT' : ''}`] = (kinds[`${i.interface}${i.compression?.compressed ? '/cNFT' : ''}`] || 0) + 1;
    console.log(w.slice(0, 6), 'items', items.length, JSON.stringify(kinds));
  } catch (e) { console.log(w.slice(0, 6), 'ERR', a.maskUrl(e.message)); }
  console.log(' avatar:', JSON.stringify(await a.getWalletAvatar(w)));
}
const tok = await a.getSolanaToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
console.log('BONK image:', tok?.imageUrl);

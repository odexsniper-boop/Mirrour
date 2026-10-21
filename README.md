# Odex Mirror — Solana Copy-Trading Web Terminal

Odex Mirror is a zero-dependency copy-trading web terminal. You paste a trader's **Solana wallet address**, and every real buy and sell that wallet makes on-chain is copied with your settings, as **paper trades** filled at live market prices. No real transactions are sent and no real money moves.

## Features

- **Wallet-only copying.** Add a trader by Solana wallet address (**Copy a Trader**). **Check wallet** reads its recent transactions and tells you whether it swaps on-chain itself (copyable) or not.
- **Per-follow settings:** exit mode (`Auto-Exit`, `Buy & Hold`, `Mirror`), sizing (`Fixed $`, `% of balance`, `Proportional 1:1`), TP/SL, minimum trade, max open positions, max at risk. Global slippage, max chase, safety and risk limits also apply.
- **Mirror mode** copies partial sells with the same share (trader sells 50% → you sell 50%).
- **5-rule Auto-Exit engine** (checked every second): Take Initials, Moonbag Trail, Two-Stage Floor, Wave-Cut, Hard Time Cap.
- **Positions:** sell initials / 50% / 100%, Sell All, Panic Sell, up to 5 armed limit orders per position, shareable PnL card.
- **Linked sections:** click a trader anywhere to open them in Copytrades; each Copytrades card has shortcuts to that trader's positions, live signals and trade history; tokens link to DexScreener; wallet addresses link to Solscan.
- **Wallet:** shows the real SOL + USDC balance of your Solana address (yours or a linked Phantom wallet), read live from the chain. Deposit QR is a Solana Pay code for that real address only. The paper balance (what paper copies spend) is separate and can be topped up or reset.
- **Bug checker** in the footer: server health (database, RPC, watcher, price feed, Supabase) plus page errors and failed requests.

## Quick Start

```bash
npm test
npm start
```

Then open `http://localhost:3400`. On Windows, `restart-server.bat` restarts it.

By default only this computer can open the terminal. To allow other devices on your network, turn it on in **Settings → Security** (or set `ODEX_HOST=0.0.0.0` in `.env`) and restart.

**Addresses:** only `/login` and `/settings` show in the address bar; everything else (Positions, Closed, Live Signals, Wallets, History, Docs) lives at `/`. Back from Settings returns to the tab you were on. Older links such as `/closed` or `/settings/profile` still open the right place and are tidied to `/` or `/settings`.

**Settings** (left menu, bottom): Copytrades, Trading & risk, Data & storage, Profile (name, time zone, start page), Security (network access, keys, sell confirmations, hide balances) and Notifications (which pop-ups appear, sound).

## Live Signals

The **Live Signals** tab watches real Solana wallets and lists their actual buys and sells as they land on-chain, with the copy result for each follow. It only reads public data and never sends a transaction.

- **What's watched:** every trader you follow, plus any wallet you paste into the tab.
- **Real-time:** each watched wallet is subscribed over the RPC's WebSocket (`logsSubscribe`), so a trade is pushed to the bot about 1 s after it lands. Failed and non-swap transactions are dropped before any lookup. Turn it off in Live Signals settings or with `ODEX_STREAM=0`.
- **Backup checks:** also polls `getSignaturesForAddress` / `getTransaction` (every 15 s by default), so nothing is missed if the stream drops. Busy wallets are read by balance changes, and each change is confirmed against the wallet's own transaction, so transfers, airdrops and spam are ignored.
- **Paper copy:** with Paper Trading on, new live buys open paper positions on the real token. Buys detected more than 90 s late are not copied.
- **RPC:** Alchemy is used when `ALCHEMY_API_KEY` is set; `SOLANA_RPC_URL` overrides it. `ODEX_LIVE_WATCH=0` starts with watching off.

## Real trading (Solana)

Switching **Paper Trading OFF** makes copies real when a bot wallet key is set. With no key, nothing is copied.

1. Create a **new Phantom account used only by the bot**, fund it with what it may trade plus ~0.05 SOL for fees.
2. Export its private key and add `ODEX_TRADER_KEY=<key>` to `.env` (never your main wallet). Optional: `JUPITER_API_KEY`.
3. Restart, open **Settings → Trading & risk → Real trading**, press **Run safe test** (signs and simulates a tiny swap; sends nothing).
4. Switch Paper Trading OFF. The console and the panel show **LIVE**.

- Orders go through Jupiter Swap API v2 (`/order` → sign locally → `/execute`), so pump.fun curve and graduated tokens both work. The key is used only on this computer's server; it is never saved, logged or sent to the browser.
- **Limits:** `ODEX_REAL_MAX_SOL_PER_TRADE` (default 0.5), `ODEX_REAL_MAX_SOL_PER_DAY` (default 2, rolling 24 h, 0 = none), `ODEX_REAL_RESERVE_SOL` (0.02 kept for fees). Your normal risk limits, filters and max chase still apply.
- **Exact numbers:** positions record the tokens and SOL that really moved on-chain, including fees and token-account rent; every fill links to Solscan.
- **Failures:** a buy that does not land opens nothing. A sell that fails keeps the position open and retries after 10 s. If Jupiter's reply is lost, the transaction is looked up on-chain before anything is recorded; if it still can't be found you get a "result unknown — check wallet" alert.
- Paper positions always settle on paper, and real positions settle for real, whatever the switch says later.
- **Slippage:** real buys use your Solana buy slippage; real sells use your sell slippage if set, otherwise Jupiter picks it from live conditions. Real sells are never blocked by a comparison with the app's own (possibly lagging) price.
- **Tokens moved outside the bot** (e.g. sold in Phantom): after 3 checks the position's automatic exits pause and you get one alert.
- **Request guard:** the API only accepts changes from this app's own page (other websites and unknown host names get 403). The sign-in screen is not a server password — keep network access (Settings → Security) off while real trading, or anyone on your network can control the bot.

## How paper PnL is counted

- **Fills:** a paper copy buy is never filled below the trader's own on-chain price (the market feed can lag by up to a minute on new launches), nor below our own paper buy of the same token in the last 30 s. Price impact is added on top.
- **Fees match a real Jupiter trade (Solana):** venue fee (pump.fun bonding curve 1.25%; PumpSwap 1.25% for small coins stepping down to 0.30% for the largest; other pools 0.25%) + Jupiter 0.5% for tokens under 24 h old (0.1% after), on every buy and sell. Gas = priority-fee preset + 5000 lamports on every trade; the first buy of a token also pays 0.00203928 SOL token-account rent. No minimum fee.
- **Cost basis** = buy size + gas (+ rent), everything taken from the paper balance. The trading fee is taken out of the tokens received.
- **Sells:** proceeds = tokens × fill price − trading fee (on the actual fill) − gas. Realized PnL = proceeds − cost basis of the part sold.
- **Open PnL** = current value − estimated sell fees − remaining cost, i.e. what selling now would return.
- **Paper balance changes** (set, top-up, reset) are logged per wallet in `paperLedger`, so start + changes − buys + sells always equals the balance.

## Alchemy (token logos, metadata, Solana RPC)

Put your key in `.env` next to `server.mjs` (see `.env.example`):

```
ALCHEMY_API_KEY=your_key
```

The key is only used by the server; the browser only ever sees a masked key.

## Database

State is saved automatically to `data/odex.db` (SQLite built into Node 22.5+; older Node versions fall back to `data/odex-db.json`): follows, positions, trade history, wallets, settings, cooldowns, Live Signals watches and recent signals.

- Settings → **Data & storage**: save now, download a JSON backup, restore a backup.
- API: `GET /api/db`, `POST /api/db/save`, `GET /api/db/export`, `POST /api/db/import`.
- `ODEX_DATA_DIR=...` changes the folder; `ODEX_DB=off` disables persistence.
- API keys are never written to the database or backups.

## Supabase cloud backup (optional)

Local SQLite stays the source of truth; every save is also copied to a Supabase table (at most every 5 seconds, and on shutdown). A fresh install with an empty local database restores itself from Supabase on start.

1. In Supabase → SQL editor, run:
   ```sql
   create table if not exists public.odex_kv (
     key text primary key,
     value jsonb not null,
     updated_at timestamptz not null default now()
   );
   alter table public.odex_kv enable row level security;
   ```
2. Settings → **Data & storage** → Supabase: paste the project URL and the **service role** key, then **Connect & back up**. Or put them in `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=your_service_role_key
   ```
- API: `GET/POST /api/db/supabase`, `POST /api/db/supabase/sync`, `/restore`, `/disconnect`.
- The key stays in `.env` on the server and is never sent to the browser (only a masked version).

// Integrations: Telegram + Discord alerts, validation, and secrets never sent to the browser.
// Run: node --test test/notifier.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../engine/notifier.mjs';
import { CopyTradingEngine } from '../engine/copyEngine.mjs';

const TOKEN = '123456789:AAHfakeTokenFakeTokenFakeToken1234';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL';

function setup() {
  const engine = new CopyTradingEngine();
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    sent.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/getUpdates')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [{ message: { chat: { id: 987654321, first_name: 'Odex' } } }] }) };
    if (url.includes('api.telegram.org')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: {} }) };
    return { ok: true, status: 204, text: async () => '' };
  };
  const n = new Notifier({ engine, fetchImpl });
  return { engine, n, sent };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pos = (over = {}) => ({ symbol: 'MEME', traderHandle: 'decu', isPaper: false, remainingTokens: 0, ...over });

test('notifier: validates Telegram token / chat id and Discord webhook', () => {
  const { n } = setup();
  assert.throws(() => n.updateTelegram({ botToken: 'nope' }), /bot token/);
  assert.throws(() => n.updateTelegram({ chatId: 'abc def' }), /Chat ID/);
  assert.throws(() => n.updateDiscord({ webhookUrl: 'https://evil.example/hook' }), /webhook/);
  n.updateTelegram({ botToken: TOKEN, chatId: '987654321', enabled: true });
  assert.equal(n.publicConfig().telegram.enabled, true);
  // can't enable without both values
  const b = setup().n;
  b.updateTelegram({ botToken: TOKEN, enabled: true });
  assert.equal(b.publicConfig().telegram.enabled, false);
});

test('notifier: finds the chat id from the bot updates', async () => {
  const { n } = setup();
  n.updateTelegram({ botToken: TOKEN });
  const r = await n.findTelegramChat();
  assert.equal(r.chatId, '987654321');
});

test('notifier: copied buy and sell go to Telegram and Discord with PnL; disabled events stay quiet', async () => {
  const { n, sent } = setup();
  n.updateTelegram({ botToken: TOKEN, chatId: '987654321', enabled: true });
  n.updateDiscord({ webhookUrl: HOOK, enabled: true, events: { copies: false } });
  n.handleEngineEvent({ type: 'position_opened', payload: { position: pos(), receipt: { amountUsd: 10, tokens: 12345, fillPriceUsd: 0.00001, txHash: 'abc', chaseGapPct: 1.2 } } });
  n.handleEngineEvent({ type: 'position_sold', payload: { position: pos(), receipt: { amountUsd: 12.5, pnlUsd: 2.5, pnlPct: 25, cause: 'trailing stop hit', txHash: 'def' } } });
  await wait(3600);
  const tg = sent.filter((s) => s.url.includes('sendMessage'));
  const dc = sent.filter((s) => s.url === HOOK);
  assert.equal(tg.length, 2, 'buy + sell to Telegram');
  assert.match(tg[0].body.text, /Bought \$MEME/);
  assert.match(tg[1].body.text, /PnL \+\$2\.50/);
  assert.equal(dc.length, 1, 'Discord: sells only (copies turned off)');
  assert.match(dc[0].body.content, /Sold \$MEME/);
});

test('notifier: red alerts are sent as problems, once each', async () => {
  const { engine, n, sent } = setup();
  n.updateTelegram({ botToken: TOKEN, chatId: '987654321', enabled: true });
  engine.alerts.unshift({ id: 'a1', level: 'danger', title: 'Real sell not executed ($X)', message: 'route failed' });
  engine.alerts.unshift({ id: 'a2', level: 'success', title: 'Copied' });
  n.scanAlerts();
  n.scanAlerts();
  await wait(1300);
  const tg = sent.filter((s) => s.url.includes('sendMessage'));
  assert.equal(tg.length, 1);
  assert.match(tg[0].body.text, /Real sell not executed/);
});

test('notifier: bot token and webhook never reach the browser state', () => {
  const { engine, n } = setup();
  n.updateTelegram({ botToken: TOKEN, chatId: '987654321', enabled: true });
  n.updateDiscord({ webhookUrl: HOOK, enabled: true });
  const snap = JSON.stringify(engine.getStateSnapshot());
  assert.ok(!snap.includes(TOKEN), 'no bot token in the snapshot');
  assert.ok(!snap.includes('abcDEF_ghi-JKL'), 'no webhook secret in the snapshot');
  assert.ok(!JSON.stringify(n.publicConfig()).includes(TOKEN));
  assert.ok(engine.settings.integrations.telegram.botToken === TOKEN, 'still saved on the server');
});

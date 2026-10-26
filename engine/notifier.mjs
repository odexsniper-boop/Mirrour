/**
 * App integrations — zero dependencies.
 *
 * Sends trade alerts to Telegram (a bot you create with @BotFather) and Discord (a channel
 * webhook). Secrets (bot token, webhook URL) live in the engine settings on the server only:
 * the browser gets masked values, and they are never logged.
 *
 * Events: copied buys, sells (with PnL), problems (failed real swaps, paused traders, …).
 */

const TG_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const TG_CHAT_RE = /^(-?\d{3,}|@[A-Za-z0-9_]{4,})$/;
const DISCORD_HOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export function defaultIntegrations() {
  return {
    telegram: { enabled: false, botToken: '', chatId: '', events: { copies: true, sells: true, problems: true } },
    discord: { enabled: false, webhookUrl: '', events: { copies: true, sells: true, problems: true } },
  };
}

const mask = (s) => {
  const v = String(s || '');
  if (!v) return null;
  return v.length <= 10 ? `${v.slice(0, 2)}…` : `${v.slice(0, 6)}…${v.slice(-4)}`;
};
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const signedUsd = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(Number(n) || 0).toFixed(2)}`;

export class Notifier {
  constructor({ engine, fetchImpl = (...a) => fetch(...a), redact = (x) => x } = {}) {
    this.engine = engine;
    this.fetch = fetchImpl;
    this.redact = redact;
    this.status = { telegram: { lastSentAt: null, lastError: null, sent: 0 }, discord: { lastSentAt: null, lastError: null, sent: 0 } };
    this.queue = [];
    this.sending = false;
    this.seenAlerts = new Set((engine.alerts || []).map((a) => a.id)); // don't replay old alerts on start
  }

  /** Live config (with secrets) — server only. */
  cfg() {
    const s = this.engine.settings;
    const d = defaultIntegrations();
    const cur = s.integrations && typeof s.integrations === 'object' ? s.integrations : {};
    s.integrations = {
      telegram: { ...d.telegram, ...(cur.telegram || {}), events: { ...d.telegram.events, ...(cur.telegram?.events || {}) } },
      discord: { ...d.discord, ...(cur.discord || {}), events: { ...d.discord.events, ...(cur.discord?.events || {}) } },
    };
    return s.integrations;
  }

  /** Safe for the browser: no secrets. */
  publicConfig() {
    const c = this.cfg();
    return {
      telegram: { enabled: c.telegram.enabled, configured: Boolean(c.telegram.botToken && c.telegram.chatId), hasToken: Boolean(c.telegram.botToken), tokenMasked: mask(c.telegram.botToken), chatId: c.telegram.chatId || '', events: c.telegram.events, ...this.status.telegram },
      discord: { enabled: c.discord.enabled, configured: Boolean(c.discord.webhookUrl), hookMasked: c.discord.webhookUrl ? `discord.com/api/webhooks/…${c.discord.webhookUrl.slice(-6)}` : null, events: c.discord.events, ...this.status.discord },
    };
  }

  // ---------- settings ----------

  updateTelegram({ botToken, chatId, enabled, events } = {}) {
    const t = this.cfg().telegram;
    if (botToken !== undefined && botToken !== '') {
      const v = String(botToken).trim();
      if (!TG_TOKEN_RE.test(v)) throw new Error('That does not look like a Telegram bot token (from @BotFather, like 123456789:AAH…).');
      t.botToken = v;
    }
    if (chatId !== undefined) {
      const v = String(chatId).trim();
      if (v && !TG_CHAT_RE.test(v)) throw new Error('Chat ID must be a number (e.g. 123456789 or -100…) or a @channelname.');
      t.chatId = v;
    }
    if (events && typeof events === 'object') for (const k of ['copies', 'sells', 'problems']) if (events[k] !== undefined) t.events[k] = Boolean(events[k]);
    if (enabled !== undefined) t.enabled = Boolean(enabled) && Boolean(t.botToken && t.chatId);
    return this.publicConfig().telegram;
  }

  updateDiscord({ webhookUrl, enabled, events } = {}) {
    const d = this.cfg().discord;
    if (webhookUrl !== undefined && webhookUrl !== '') {
      const v = String(webhookUrl).trim();
      if (!DISCORD_HOOK_RE.test(v)) throw new Error('Paste a Discord webhook URL (Channel settings → Integrations → Webhooks → Copy Webhook URL).');
      d.webhookUrl = v;
    }
    if (events && typeof events === 'object') for (const k of ['copies', 'sells', 'problems']) if (events[k] !== undefined) d.events[k] = Boolean(events[k]);
    if (enabled !== undefined) d.enabled = Boolean(enabled) && Boolean(d.webhookUrl);
    return this.publicConfig().discord;
  }

  disconnect(channel) {
    const c = this.cfg();
    if (channel === 'telegram') c.telegram = { ...defaultIntegrations().telegram };
    if (channel === 'discord') c.discord = { ...defaultIntegrations().discord };
    this.status[channel] = { lastSentAt: null, lastError: null, sent: 0 };
    return this.publicConfig();
  }

  /** After the user messages their bot: find the chat id from the bot's recent updates. */
  async findTelegramChat(botToken) {
    const token = String(botToken || this.cfg().telegram.botToken || '').trim();
    if (!TG_TOKEN_RE.test(token)) throw new Error('Save your bot token first.');
    const r = await this.http(`https://api.telegram.org/bot${token}/getUpdates?limit=20&timeout=0`, { method: 'GET' });
    if (!r.ok) throw new Error(r.description || 'Telegram rejected the bot token.');
    const updates = Array.isArray(r.result) ? r.result : [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat || u.edited_message?.chat;
      if (chat?.id) return { chatId: String(chat.id), name: chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || 'chat' };
    }
    throw new Error('No messages yet. Open your bot in Telegram, press Start (or send "hi"), then try again.');
  }

  // ---------- sending ----------

  async http(url, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await this.fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (json && typeof json === 'object' && 'ok' in json) return json; // Telegram style
      return { ok: res.ok, status: res.status, description: !res.ok ? (json?.message || text || `HTTP ${res.status}`).slice(0, 200) : null };
    } catch (err) {
      return { ok: false, description: err.name === 'AbortError' ? 'request timed out' : err.message };
    } finally {
      clearTimeout(t);
    }
  }

  async sendTelegram(html) {
    const t = this.cfg().telegram;
    const r = await this.http(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    this.mark('telegram', r.ok, r.description || (r.ok ? null : 'Telegram refused the message'));
    return r.ok;
  }

  async sendDiscord(markdown) {
    const d = this.cfg().discord;
    const r = await this.http(d.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Odex Mirror', content: markdown.slice(0, 1900) }) });
    this.mark('discord', r.ok, r.description || (r.ok ? null : 'Discord refused the message'));
    return r.ok;
  }

  /**
   * Dax report: a short summary message plus the full report as a .md file, to every connected
   * app (or just one). Returns { telegram, discord } (true / false / null = not connected).
   */
  async sendReport({ summary, markdown, filename = 'dax-report.md' }, only = null) {
    const c = this.cfg();
    const out = { telegram: null, discord: null };
    const want = (ch) => (!only || only === ch || only === 'both') && c[ch].enabled;
    if (want('telegram')) {
      const fd = new FormData();
      fd.append('chat_id', String(c.telegram.chatId));
      fd.append('caption', String(summary).slice(0, 1000));
      fd.append('document', new Blob([markdown], { type: 'text/markdown' }), filename);
      const r = await this.http(`https://api.telegram.org/bot${c.telegram.botToken}/sendDocument`, { method: 'POST', body: fd });
      // a caption over Telegram's limit or a refused file: fall back to the summary as a message
      out.telegram = r.ok ? true : await this.sendTelegram(escHtml(String(summary).slice(0, 3900)));
      if (r.ok) this.mark('telegram', true);
    }
    if (want('discord')) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ username: 'Dax · Odex Mirror', content: String(summary).slice(0, 1900) }));
      fd.append('files[0]', new Blob([markdown], { type: 'text/markdown' }), filename);
      const r = await this.http(c.discord.webhookUrl, { method: 'POST', body: fd });
      out.discord = Boolean(r.ok);
      this.mark('discord', r.ok, r.description || (r.ok ? null : 'Discord refused the report'));
    }
    return out;
  }

  mark(ch, ok, err) {
    const s = this.status[ch];
    if (ok) {
      s.lastSentAt = Date.now();
      s.lastError = null;
      s.sent += 1;
    } else {
      s.lastError = { at: Date.now(), error: this.redact(String(err || 'failed')).slice(0, 200) };
    }
  }

  /** Queue one message for every enabled app that wants this kind of event (max ~1 per second). */
  notify(kind, { html, md }) {
    const c = this.cfg();
    if (c.telegram.enabled && c.telegram.events[kind]) this.queue.push(['telegram', html]);
    if (c.discord.enabled && c.discord.events[kind]) this.queue.push(['discord', md]);
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
    this.drain();
  }

  async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const [ch, text] = this.queue.shift();
        if (ch === 'telegram') await this.sendTelegram(text);
        else await this.sendDiscord(text);
        await new Promise((r) => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }

  async test(channel) {
    const c = this.cfg();
    const mode = this.engine.settings.paperTrading === false ? 'REAL trading' : 'Paper trading';
    if (channel === 'telegram') {
      if (!c.telegram.botToken || !c.telegram.chatId) throw new Error('Add the bot token and chat ID first.');
      const ok = await this.sendTelegram(`✅ <b>Odex Mirror connected</b>\nTrade alerts will arrive here. Mode: ${mode}.`);
      if (!ok) throw new Error(this.status.telegram.lastError?.error || 'Telegram refused the message');
      return true;
    }
    if (channel === 'discord') {
      if (!c.discord.webhookUrl) throw new Error('Add the webhook URL first.');
      const ok = await this.sendDiscord(`✅ **Odex Mirror connected**\nTrade alerts will arrive here. Mode: ${mode}.`);
      if (!ok) throw new Error(this.status.discord.lastError?.error || 'Discord refused the message');
      return true;
    }
    throw new Error('Unknown app');
  }

  // ---------- engine events ----------

  handleEngineEvent(evt) {
    try {
      if (evt.type === 'position_opened') this.onBuy(evt.payload?.position, evt.payload?.receipt);
      else if (evt.type === 'position_sold') this.onSell(evt.payload?.position, evt.payload?.receipt);
      this.scanAlerts();
    } catch {
      // never let a notification break trading
    }
  }

  onBuy(p, r) {
    if (!p || !r) return;
    const tag = p.isPaper ? 'paper' : 'REAL';
    const tx = r.txHash ? `https://solscan.io/tx/${r.txHash}` : null;
    const px = Number(r.fillPriceUsd) || 0;
    const line2 = `${usd(r.amountUsd)} → ${Number(r.tokens || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens @ $${px < 0.01 ? px.toPrecision(3) : px.toFixed(4)}`;
    this.notify('copies', {
      html: `🟢 <b>Bought $${escHtml(p.symbol)}</b> · ${tag}\n${escHtml(line2)}\nCopied @${escHtml(p.traderHandle)}${r.chaseGapPct != null ? ` · ${r.chaseGapPct >= 0 ? '+' : ''}${Number(r.chaseGapPct).toFixed(1)}% vs trader` : ''}${tx ? `\n<a href="${tx}">View on Solscan</a>` : ''}`,
      md: `🟢 **Bought $${p.symbol}** · ${tag}\n${line2}\nCopied @${p.traderHandle}${tx ? `\n<${tx}>` : ''}`,
    });
  }

  onSell(p, r) {
    if (!p || !r) return;
    const tag = p.isPaper ? 'paper' : 'REAL';
    const pnl = Number(r.pnlUsd) || 0;
    const icon = pnl >= 0 ? '💰' : '🔻';
    const closed = !(p.remainingTokens > 0);
    const tx = r.txHash ? `https://solscan.io/tx/${r.txHash}` : null;
    const line2 = `${usd(r.amountUsd)} back · PnL ${signedUsd(pnl)} (${pnl >= 0 ? '+' : ''}${Number(r.pnlPct || 0).toFixed(1)}%)${closed ? '' : ' · partial'}`;
    this.notify('sells', {
      html: `${icon} <b>Sold $${escHtml(p.symbol)}</b> · ${tag}\n${escHtml(line2)}\n${escHtml(r.cause || 'sell')}${tx ? `\n<a href="${tx}">View on Solscan</a>` : ''}`,
      md: `${icon} **Sold $${p.symbol}** · ${tag}\n${line2}\n${r.cause || 'sell'}${tx ? `\n<${tx}>` : ''}`,
    });
  }

  /** New red alerts (failed real swaps, paused traders, limits hit) → "problems". */
  scanAlerts() {
    for (const a of (this.engine.alerts || []).slice(0, 10)) {
      if (!a?.id || this.seenAlerts.has(a.id)) continue;
      this.seenAlerts.add(a.id);
      if (a.level !== 'danger') continue;
      this.notify('problems', { html: `⚠️ <b>${escHtml(a.title)}</b>\n${escHtml(a.message || '')}`, md: `⚠️ **${a.title}**\n${a.message || ''}` });
    }
    if (this.seenAlerts.size > 500) this.seenAlerts = new Set([...this.seenAlerts].slice(-250));
  }
}

/**
 * Dax chat — talk to the report agent (text, voice messages, voice calls).
 *
 * With ANTHROPIC_API_KEY set, every question goes to Claude with READ-ONLY tools over the bot's
 * own records (Dax's report, open positions, the trader trade log, settings). Dax can look at
 * everything but can never buy, sell or change a setting: no such tool exists.
 * Without a key Dax still answers in basic mode from his report findings.
 *
 * Zero dependencies: Node 22's fetch. The key stays on the server and is never put in a reply.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 24; // messages sent per request (the browser keeps the conversation)

const TOOLS = [
  {
    name: 'get_report',
    description: "Dax's full trade report for a period: results real vs paper, each trader (setup, copied vs skipped buys and why, our result vs the trader's own result per coin), exits that sold past their limit, results by exit, speed, bot wallet and limits, failed real orders, and a CSV of every closed trade. Use this first for any question about results, losses, wins or why something happened.",
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', '24h', '7d', 'all'], description: 'today = UTC day so far' } }, required: ['period'] },
  },
  {
    name: 'get_open_positions',
    description: 'Positions open right now: coin, real or paper, cost, current value and PnL, peak gain, how long held, exit rules that apply.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trader_trades',
    description: "The followed traders' own buys and sells (price, USD size, % of bag sold, market cap) and what the bot did with each (copied or skipped and why), newest first. Filter by coin symbol or mint and by hours back. Use it to explain why the trader won or lost on a coin and how our copy differed.",
    input_schema: { type: 'object', properties: { coin: { type: 'string', description: 'symbol (e.g. ALONE) or mint address; omit for all coins' }, hours: { type: 'number', description: 'how far back, default 24' }, limit: { type: 'number', description: 'max rows, default 60' } } },
  },
  {
    name: 'get_settings',
    description: 'Current setup: paper or real mode, each trader (mode, exit rules, size, stop loss, max chase, top-ups, daily SOL limit, sell-when-trader-sells), overall real-SOL limits and the bot wallet balance.',
    input_schema: { type: 'object', properties: {} },
  },
];

function systemPrompt({ voice }) {
  return [
    'You are Dax, the built-in report agent of Odex Mirror, a Solana copy-trading bot that copies followed wallets (for example the trader "Decu") with paper money or real SOL from a bot wallet.',
    "You can read everything the bot recorded through your tools. You can NOT trade, sell, change settings or move funds — if asked, say what the user can change and where (trader Settings, exit rules presets such as \"Follow the trader\" or \"Fast scalp\", Settings → Trading & risk).",
    'Always get the facts from the tools before answering about results; never invent numbers. Quote the exact coins, percentages and dollar amounts you found. Compare our copy with the trader\'s own result on the same coin when explaining a win or a loss (entry later/higher, exit rule that sold us, how far past its limit, the trader holding through a dip, etc.).',
    'Be direct and practical: give the cause, the numbers, and the one or two changes that would help most. You are not a financial advisor: no promises of profit.',
    'Reply in the language the user writes or speaks in.',
    voice
      ? 'This is a VOICE conversation: answer in at most 3 short spoken sentences, no lists, no tables, no markdown, no emojis, round numbers (say "about 15 percent"). Offer to go deeper if needed.'
      : 'This is a text chat: be concise. Short paragraphs or a few bullets; a small table only when comparing several trades.',
  ].join('\n');
}

export class DaxChat {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY || '', model = process.env.DAX_MODEL || 'claude-sonnet-5-5', fetchImpl = (...a) => fetch(...a), tools = {}, basicAnswer = null, now = () => Date.now() } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.model = model;
    this.fetch = fetchImpl;
    this.tools = tools; // { get_report(input), get_open_positions(), get_trader_trades(input), get_settings() } → string | object
    this.basicAnswer = basicAnswer; // (question) → string, used without a key
    this.now = now;
    this.recent = []; // request times for the rate limit
    this.stats = { requests: 0, lastError: null, lastErrorAt: null, inputTokens: 0, outputTokens: 0 };
  }

  get aiEnabled() {
    return Boolean(this.apiKey);
  }

  status() {
    return { ai: this.aiEnabled, model: this.aiEnabled ? this.model : null, requests: this.stats.requests, lastError: this.stats.lastError, lastErrorAt: this.stats.lastErrorAt };
  }

  /** At most 20 questions a minute (protects the API bill if something loops). */
  allow() {
    const t = this.now();
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.recent.length >= 20) return false;
    this.recent.push(t);
    return true;
  }

  async runTool(name, input) {
    const fn = this.tools[name];
    if (typeof fn !== 'function') return `Unknown tool ${name}`;
    try {
      const out = await fn(input || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(cut)` : text;
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  /**
   * One reply. history: [{ role: 'user'|'assistant', text }] (oldest first, last = the question).
   * Returns { ok, text, mode: 'ai'|'basic', toolsUsed }.
   */
  async reply(history, { voice = false } = {}) {
    const clean = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
    while (clean.length && clean[0].role !== 'user') clean.shift(); // the API needs a user turn first
    const question = clean.length ? clean[clean.length - 1].content : '';
    if (!question || clean[clean.length - 1].role !== 'user') return { ok: false, error: 'Ask Dax something first.' };
    if (!this.allow()) return { ok: false, error: 'Dax is getting a lot of questions — try again in a minute.' };
    this.stats.requests += 1;

    if (!this.aiEnabled) {
      const text = this.basicAnswer ? await this.basicAnswer(question, { voice }) : 'Dax needs an ANTHROPIC_API_KEY to chat.';
      return { ok: true, text, mode: 'basic', toolsUsed: [] };
    }

    const messages = clean.slice();
    const toolsUsed = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res;
      try {
        res = await this.call({ messages, voice, allowTools: round < MAX_TOOL_ROUNDS });
      } catch (err) {
        this.stats.lastError = String(err.message || err).slice(0, 200);
        this.stats.lastErrorAt = this.now();
        return { ok: false, error: `Dax could not reach Claude: ${this.stats.lastError}` };
      }
      const blocks = Array.isArray(res.content) ? res.content : [];
      const uses = blocks.filter((b) => b.type === 'tool_use');
      if (res.stop_reason === 'tool_use' && uses.length) {
        messages.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const u of uses) {
          toolsUsed.push(u.name);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: await this.runTool(u.name, u.input) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { ok: true, text: text || '(no answer)', mode: 'ai', toolsUsed };
    }
    return { ok: false, error: 'Dax looked at too many things at once — ask a narrower question.' };
  }

  async call({ messages, voice, allowTools }) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const body = { model: this.model, max_tokens: voice ? 400 : 1500, system: systemPrompt({ voice }), messages };
      if (allowTools) body.tools = TOOLS;
      const r = await this.fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      if (!r.ok) throw new Error(json?.error?.message ? `${r.status}: ${json.error.message}` : `HTTP ${r.status}`);
      if (json?.usage) {
        this.stats.inputTokens += Number(json.usage.input_tokens) || 0;
        this.stats.outputTokens += Number(json.usage.output_tokens) || 0;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('timed out');
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Basic-mode answer (no API key): Dax's findings for the period the question points at. */
export function basicDaxAnswer(question, report, { voice = false } = {}) {
  const f = report.findings || [];
  const lead = `Here is what I found for ${report.period.label.toLowerCase()}:`;
  const lines = f.slice(0, voice ? 3 : 8).map((x) => x.text);
  const note = voice ? '' : '\n\n(Basic mode: I can only read out my report findings. Add ANTHROPIC_API_KEY on Railway and I can answer any question about your trades.)';
  return voice ? `${lead} ${lines.join(' ')}` : `${lead}\n\n${lines.map((l) => `• ${l}`).join('\n')}${note}`;
}

/** Which report period a question is about. */
export function periodFromQuestion(q) {
  const s = String(q || '').toLowerCase();
  if (/week|7 ?d|seven days/.test(s)) return '7d';
  if (/all time|ever|everything/.test(s)) return 'all';
  if (/today|this morning|tonight/.test(s)) return 'today';
  return '24h';
}

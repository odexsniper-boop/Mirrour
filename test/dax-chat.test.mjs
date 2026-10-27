// Dax chat: Claude tool loop with read-only tools, basic mode, limits (offline, mock API).
// Run: node --test test/dax-chat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DaxChat, basicDaxAnswer, periodFromQuestion } from '../engine/daxChat.mjs';

const KEY = 'sk-ant-test-SECRETKEY-1234567890';

function mockApi(script) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const next = script.shift();
    if (next instanceof Error) throw next;
    const { status = 200, json } = next;
    return { ok: status < 400, status, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

test('DC1 Dax looks at the report with a tool, then answers; only read-only tools exist', async () => {
  const { calls, fetchImpl } = mockApi([
    { json: { content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'get_report', input: { period: '24h' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } } },
    { json: { content: [{ type: 'text', text: 'ROBODICK lost because the stop sold 23 points past its limit.' }], stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 } } },
  ]);
  const seen = [];
  const dax = new DaxChat({ apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl, tools: { get_report: ({ period }) => (seen.push(period), '# Dax report\n- ROBODICK −53% (stop 30%)') } });
  const r = await dax.reply([{ role: 'user', text: 'why did ROBODICK lose?' }]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'ai');
  assert.match(r.text, /23 points past/);
  assert.deepEqual(r.toolsUsed, ['get_report']);
  assert.deepEqual(seen, ['24h']);
  // request shape: endpoint, headers, model, tools, tool_result round trip
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers['x-api-key'], KEY);
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  const names = calls[0].body.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_open_positions', 'get_report', 'get_settings', 'get_trader_trades']);
  assert.ok(!names.some((n) => /sell|buy|trade_now|set|update|withdraw/.test(n) && n !== 'get_trader_trades' && n !== 'get_settings'), 'no tool can trade or change anything');
  const second = calls[1].body.messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'tu1');
  assert.match(second[2].content[0].content, /ROBODICK/);
});

test('DC2 voice questions ask for short spoken answers', async () => {
  const { calls, fetchImpl } = mockApi([{ json: { content: [{ type: 'text', text: 'About 15 percent down.' }], stop_reason: 'end_turn' } }]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl });
  await dax.reply([{ role: 'user', text: 'how am I doing' }], { voice: true });
  assert.match(calls[0].body.system, /VOICE conversation/);
  assert.equal(calls[0].body.max_tokens, 400);
});

test('DC3 without a key Dax answers in basic mode from his findings', async () => {
  const dax = new DaxChat({ apiKey: '', basicAnswer: (q) => `basic: ${q}` });
  const r = await dax.reply([{ role: 'user', text: 'what happened today' }]);
  assert.deepEqual([r.ok, r.mode, r.text], [true, 'basic', 'basic: what happened today']);
  const report = { period: { label: 'Last 24 hours' }, findings: [{ text: 'Real SOL: 3 trades.' }, { text: 'Wallet low.' }] };
  assert.match(basicDaxAnswer('x', report), /• Real SOL: 3 trades\.[\s\S]*ANTHROPIC_API_KEY/);
  assert.doesNotMatch(basicDaxAnswer('x', report, { voice: true }), /•|ANTHROPIC/);
  assert.equal(periodFromQuestion('how was this week'), '7d');
  assert.equal(periodFromQuestion('today?'), 'today');
  assert.equal(periodFromQuestion('why did I lose'), '24h');
});

test('DC4 API errors are reported without the key; history must start with a question; rate limit', async () => {
  const { fetchImpl } = mockApi([{ status: 401, json: { error: { message: 'invalid x-api-key' } } }]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl });
  const r = await dax.reply([{ role: 'assistant', text: 'hello' }, { role: 'user', text: 'hi' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
  assert.ok(!r.error.includes(KEY));
  assert.equal((await dax.reply([{ role: 'assistant', text: 'only me' }])).ok, false);
  let t = 0;
  const lim = new DaxChat({ apiKey: '', basicAnswer: () => 'ok', now: () => t });
  for (let i = 0; i < 20; i++) assert.equal((await lim.reply([{ role: 'user', text: 'q' }])).ok, true);
  assert.match((await lim.reply([{ role: 'user', text: 'q' }])).error, /a lot of questions/);
  t += 61_000;
  assert.equal((await lim.reply([{ role: 'user', text: 'q' }])).ok, true, 'free again after a minute');
});

test('DC5 a tool that throws is reported to Claude, not crashing the chat', async () => {
  const { calls, fetchImpl } = mockApi([
    { json: { content: [{ type: 'tool_use', id: 'a', name: 'get_open_positions', input: {} }], stop_reason: 'tool_use' } },
    { json: { content: [{ type: 'text', text: 'No positions could be read.' }], stop_reason: 'end_turn' } },
  ]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl, tools: { get_open_positions: () => { throw new Error('db busy'); } } });
  const r = await dax.reply([{ role: 'user', text: 'open positions?' }]);
  assert.equal(r.ok, true);
  assert.match(calls[1].body.messages[2].content[0].content, /Tool error: db busy/);
});

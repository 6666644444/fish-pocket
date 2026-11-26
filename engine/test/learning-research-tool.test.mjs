import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import Learning, { ROUTE, pausedResearchNote } from '../plugins/learning/index.mjs';
import { TOOL, fetchPage, researchTools, sessionTarget } from '../plugins/learning/research-tool.mjs';
import { LearningStore } from '../plugins/learning/store.mjs';
import { canDecodeGbk, htmlTitle, htmlToText, legacyCharset, metaCharset, refusedCharset } from '../plugins/learning/webtext.mjs';

// A canned model good enough for a full quick run (same shapes as learning-research's fake).
async function cannedModel(_llm, target, { system, user }) {
  assert.deepEqual(target, { provider: 'deepseek', model: 'deepseek-chat' }, 'the session\'s model is used');
  if (system.startsWith('You plan')) return '{"subtopics":[{"title":"Part one","overview":"o"}]}';
  if (system.startsWith('You research')) {
    const cit = /\[(CIT-[\w-]+)\]/.exec(user)?.[1];
    return cit ? JSON.stringify({ action: 'finish', summary: `Fact [${cit}].` }) : '{"action":"search","query":"part one"}';
  }
  if (system.startsWith('Summarise one tool result')) return 'note';
  if (system.startsWith('From the research summaries')) return '{"claims":[]}';
  if (system.startsWith('Review a research run')) return '{"gaps":[]}';
  if (system.startsWith('Plan a research report')) return '{"title":"Report","sections":[{"title":"One","intent":"i","blocks":["B1"]}]}';
  if (system.startsWith('Write section')) return `## 1. One\nFact [${/\[(CIT-[\w-]+)\]/.exec(user)?.[1]}].`;
  if (system.startsWith('Write the opening summary')) return '## Summary\nShort.';
  return '{}';
}

const web = {
  search: async ({ query }) => ({ sources: [{ url: `https://example.com/${encodeURIComponent(query)}`, title: `About ${query}`, snippet: 'snippet' }], truncated: false }),
  fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: '<p>Hello <b>world</b></p>' }, truncated: false }),
};

function plugin({ withJobs = true } = {}) {
  const routes = new Map();
  const tools = [];
  const started = [];
  const disposers = [];
  const jobs = {
    start: (spec) => {
      started.push(spec);
      const hooks = spec.run({ id: `research-${started.length}`, append: (text) => spec.appended = (spec.appended ?? '') + text, updateProgress: (line) => spec.progress = line });
      spec.hooks = hooks;
      return `research-${started.length}`;
    },
  };
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: (tool, options) => { tools.push({ tool, options }); return () => {}; } },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-rtool-')), 'learning', 'learning.db');
  const instance = new Learning(ctx, { file, embedder: null, callModel: cannedModel, services: { llm: {}, web, jobs: withJobs ? jobs : undefined } });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  const research = tools.find((t) => t.tool.name === TOOL);
  return { file, instance, research, started, post, dispose: () => disposers.reverse().forEach((d) => d()) };
}

const agent = {
  session: { id: 'sess-r', header: {}, requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) },
  options: {},
};

test('the deep-research skill ships with valid frontmatter and points at the tool', () => {
  const text = fs.readFileSync(new URL('../skills/deep-research/SKILL.md', import.meta.url), 'utf8');
  const [, head, body] = text.split(/^---\r?$/m);
  const meta = parseYaml(head);
  assert.equal(meta.name, 'deep-research');
  assert.ok(meta.description.length > 40 && meta.description.length <= 500);
  assert.match(body, /deep_research/);
});

test('sessionTarget: the routed model first, the agent options second', () => {
  assert.deepEqual(sessionTarget(agent), { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(sessionTarget({ session: { requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' });
  assert.equal(sessionTarget({ session: {}, options: {} }), undefined);
});

test('researchTools: web through ctx.web (HTML stripped), kb only when there are documents', async () => {
  const store = new LearningStore(':memory:');
  const none = researchTools({ web: undefined, store, sources: ['web', 'kb'] });
  assert.deepEqual(Object.keys(none), []);
  const withWeb = researchTools({ web, store, sources: ['web', 'kb'] });
  assert.deepEqual(Object.keys(withWeb).sort(), ['fetch', 'search']);
  assert.equal((await withWeb.search('x')).results[0].url, 'https://example.com/x');
  assert.equal((await withWeb.fetch('https://a.example')).text, 'Hello world');
  await assert.rejects(withWeb.fetch('file:///etc/passwd'), /http/);
  store.importDocument({ title: 'Notes', kind: 'txt', text: '算盘是一种古老的计算工具。'.repeat(20) });
  const withKb = researchTools({ web, store, sources: ['kb'] });
  assert.deepEqual(Object.keys(withKb), ['kb']);
  assert.equal((await withKb.kb('算盘')).results[0].documentTitle, 'Notes');
  store.close();
});

test('the tool starts a job owned by the session, the run finishes, the report reads back', async () => {
  const p = plugin();
  assert.ok(p.research, 'deep_research is registered');
  assert.equal(p.research.options.when({ agent }), true);
  assert.equal(p.research.options.when({ agent: { session: { header: { origin: 'subagent' } } } }), false);
  const start = await p.research.tool.execute({ action: 'start', topic: 'Abacus history', depth: 'quick' }, { agent });
  assert.equal(start.started, true);
  assert.equal(p.started.length, 1);
  assert.equal(p.started[0].owner, 'sess-r');
  assert.equal(p.started[0].kind, 'research');
  const outcome = await p.started[0].hooks.done;
  assert.deepEqual(outcome, { kind: 'completed', result: 'done' });
  assert.match(p.started[0].appended, /finished/);
  const report = await p.research.tool.execute({ action: 'report', id: start.job.id }, { agent });
  assert.equal(report.job.status, 'done');
  assert.match(report.job.report, /^# Report/);
  assert.match(report.job.report, /\[1\]/);
  assert.equal(p.research.tool.output.render({ action: 'report' }, report)[0].text, report.job.report);
  const listed = (await p.post('research.list')).body.result;
  assert.equal(listed[0].status, 'done');
  assert.deepEqual(listed[0].target, { provider: 'deepseek', model: 'deepseek-chat' });
  p.dispose();
});

test('web turned off in settings leaves only the knowledge base, or refuses with no source', async () => {
  const p = plugin();
  await p.post('settings.update', { researchWeb: false });
  await assert.rejects(p.research.tool.execute({ action: 'start', topic: 'x', sources: ['web'] }, { agent }), /turned off/);
  const start = await p.research.tool.execute({ action: 'start', topic: 'x' }, { agent });
  assert.deepEqual(start.job.sources, ['kb']);
  const final = (await p.post('research.get', { id: start.job.id })).body.result;
  await p.started.at(-1)?.hooks.done;
  const after = (await p.post('research.get', { id: start.job.id })).body.result;
  assert.equal(after.status, 'failed', JSON.stringify(final));
  assert.match(after.error, /no research source/);
  p.dispose();
});

test('an engine restart pauses a running job; the app resumes it with the model it started with', async () => {
  const first = plugin();
  const store = new LearningStore(first.file);
  const job = store.createResearchJob({ topic: 'Resume me', depth: 'quick', sessionId: 'gone' });
  store.setResearchTarget({ id: job.id, target: { provider: 'deepseek', model: 'deepseek-chat' } });
  store.setResearchStatus({ id: job.id, status: 'running' });
  store.close();
  first.dispose();
  // A new plugin instance on the same library is a restarted engine.
  const routes = new Map();
  const ctx = {
    effect: (run) => run(), on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
    tools: { register: () => () => {} },
  };
  const restarted = new Learning(ctx, { file: first.file, embedder: null, callModel: cannedModel, services: { llm: {}, web, jobs: undefined } });
  const post = async (method, body) => (await (await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }))).json());
  assert.equal((await post('research.get', { id: job.id })).result.status, 'paused');
  const resumed = await post('research.resume', { id: job.id });
  assert.equal(resumed.result.started, true);
  await restarted.research.running.get(job.id)?.settled;
  assert.equal((await post('research.get', { id: job.id })).result.status, 'done');
  assert.equal((await post('research.resume', { id: job.id })).result.started, false, 'a finished job does not start again');
  assert.equal((await post('research.delete', { id: job.id })).result.deleted, true);
});

test('cancel through the app; delete refuses a running job', async () => {
  const p = plugin({ withJobs: false });
  const start = await p.research.tool.execute({ action: 'start', topic: 'Cancel me' }, { agent });
  assert.equal((await p.post('research.delete', { id: start.job.id })).status, 409);
  const cancelled = (await p.post('research.cancel', { id: start.job.id })).body.result;
  assert.ok(['running', 'cancelled'].includes(cancelled.status));
  await p.instance.research.running.get(start.job.id)?.settled;
  const final = (await p.post('research.get', { id: start.job.id })).body.result.status;
  assert.ok(['cancelled', 'paused'].includes(final), final);
  p.dispose();
});

// Pages (webtext.mjs)

test('page text: scripts, styles, navigation and forms dropped; entities decoded; the title kept', () => {
  const html = '<html><head><title>2026 &amp; 高考</title><style>p{}</style><script>var x="<p>no</p>";</script></head>'
    + '<body><nav>首页 | 新闻</nav><div>第一段&nbsp;内容&#x4E2D;&#25991;</div><p>第二段</p><!-- c --><footer>版权所有</footer>'
    + '<form><input></form><aside>广告</aside></body></html>';
  assert.equal(htmlTitle(html), '2026 & 高考');
  assert.equal(htmlToText(html), '第一段 内容中文\n第二段');
  assert.equal(htmlToText('<header>Kept header</header><p>a</p>'), 'Kept header a');
});

test('charset labels: what DSH refused, what a page names in <meta>', () => {
  assert.equal(refusedCharset(new Error('unsupported charset "GBK"')), 'gbk');
  assert.equal(refusedCharset(new Error('unsupported charset "koi8-r"')), undefined, 'only the Chinese legacy ones are tried');
  assert.equal(refusedCharset(new Error('timed out')), undefined);
  assert.equal(metaCharset('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'), 'gb2312');
  assert.equal(metaCharset('<meta charset="GB18030" />'), 'gb18030');
  assert.equal(legacyCharset('utf-8'), undefined);
});

// "中文页面" in GBK, inside a small page.
const gbkPage = () => {
  const head = new TextEncoder().encode('<html><head><meta charset="gbk"><title>T</title></head><body><p>');
  const text = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xd2, 0xb3, 0xc3, 0xe6]);
  const tail = new TextEncoder().encode('</p></body></html>');
  return Uint8Array.from([...head, ...text, ...tail]);
};
const respond = (bytes, { status = 200, headers = { 'content-type': 'text/html; charset=gbk' } } = {}) => new Response(bytes, { status, headers });

test('a GBK page DSH refuses is read again and decoded', { skip: !canDecodeGbk() && 'this Node has no GBK decoder' }, async () => {
  const asked = [];
  const refusing = { fetch: async () => { throw new Error('unsupported charset "gbk"'); } };
  const page = await fetchPage(refusing, 'https://exam.example/a.html', undefined, { fetchImpl: async (url, init) => { asked.push([url, init.redirect]); return respond(gbkPage()); } });
  assert.equal(page.text, '中文页面');
  assert.deepEqual(asked, [['https://exam.example/a.html', 'manual']]);
});

test('a page naming GBK only in <meta> (garbled as UTF-8 by DSH) is read again', { skip: !canDecodeGbk() && 'this Node has no GBK decoder' }, async () => {
  const garbled = { fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: `<meta charset="gbk"><p>${'\uFFFD'.repeat(40)}</p>` } }) };
  const page = await fetchPage(garbled, 'https://exam.example/b.html', undefined, { fetchImpl: async () => respond(gbkPage()) });
  assert.equal(page.text, '中文页面');
  const fine = { fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: '<meta charset="gbk"><p>已是中文</p>' } }) };
  let refetched = false;
  assert.equal((await fetchPage(fine, 'https://exam.example/c.html', undefined, { fetchImpl: async () => { refetched = true; return respond(gbkPage()); } })).text, '已是中文');
  assert.equal(refetched, false, 'a page DSH decoded well is not read twice');
});

test('the second read keeps to DSH\'s rules: same-origin redirects only, then gives up with DSH\'s error', { skip: !canDecodeGbk() && 'this Node has no GBK decoder' }, async () => {
  const refusing = { fetch: async () => { throw new Error('unsupported charset "gbk"'); } };
  const away = async () => respond(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  await assert.rejects(fetchPage(refusing, 'https://exam.example/a.html', undefined, { fetchImpl: away }), /unsupported charset/);
  let hops = 0;
  const near = async (url) => (hops++ === 0 ? respond(null, { status: 301, headers: { location: '/moved.html' } }) : respond(gbkPage()));
  assert.equal((await fetchPage(refusing, 'https://exam.example/a.html', undefined, { fetchImpl: near })).url, 'https://exam.example/moved.html');
  const binary = async () => respond(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(fetchPage(refusing, 'https://exam.example/a.pdf', undefined, { fetchImpl: binary }), /unsupported charset/);
});

// Running research in a conversation

test('one research at a time in a conversation: a second start reports the running one', async () => {
  const p = plugin({ withJobs: false });
  // A model that never answers keeps the first run going.
  p.instance.research.call = () => new Promise(() => {});
  const first = await p.research.tool.execute({ action: 'start', topic: 'First question' }, { agent });
  assert.equal(first.started, true);
  const second = await p.research.tool.execute({ action: 'start', topic: 'Another question' }, { agent });
  assert.equal(second.started, false);
  assert.equal(second.job.id, first.job.id);
  assert.match(p.research.tool.output.render({ action: 'start' }, second)[0].text, /already running/);
  assert.equal((await p.post('research.list')).body.result.length, 1, 'no second job was created');
  const other = { session: { ...agent.session, id: 'sess-other' }, options: {} };
  assert.equal((await p.research.tool.execute({ action: 'start', topic: 'Elsewhere' }, { agent: other })).started, true, 'another conversation may run its own');
  p.instance.research.stopped.abort();
  p.dispose();
});

test('start on the question of a paused job in the same conversation resumes it', async () => {
  const p = plugin();
  const store = new LearningStore(p.file);
  const paused = store.createResearchJob({ topic: '2026 新高考数学命题趋势', depth: 'quick', sessionId: 'sess-r' });
  store.setResearchStatus({ id: paused.id, status: 'paused' });
  const elsewhere = store.createResearchJob({ topic: '2026 新高考数学命题趋势', depth: 'quick', sessionId: 'sess-other' });
  store.setResearchStatus({ id: elsewhere.id, status: 'paused' });
  store.close();
  const start = await p.research.tool.execute({ action: 'start', topic: '2026新高考数学的命题趋势', depth: 'quick' }, { agent });
  assert.equal(start.resumed, true);
  assert.equal(start.job.id, paused.id);
  assert.match(p.research.tool.output.render({ action: 'start' }, start)[0].text, /continues paused research/);
  await p.instance.research.running.get(paused.id)?.settled;
  const fresh = await p.research.tool.execute({ action: 'start', topic: '算盘的历史', depth: 'quick' }, { agent });
  assert.notEqual(fresh.job.id, paused.id, 'a different question is a new job');
  assert.equal(fresh.resumed, undefined);
  p.dispose();
});

test('a paused research is mentioned to the model once, only in its own conversation', () => {
  const store = new LearningStore(':memory:');
  const job = store.createResearchJob({ topic: 'Paused one', depth: 'quick', sessionId: 's1' });
  store.setResearchStatus({ id: job.id, status: 'paused' });
  const state = { running: new Map(), told: new Set() };
  assert.equal(pausedResearchNote(store, 'other', state), undefined);
  const note = pausedResearchNote(store, 's1', state);
  assert.match(note.content[0].text, new RegExp(`research #${job.id} "Paused one"`));
  assert.match(note.content[0].text, /action "resume"/);
  assert.match(note.content[0].text, /设置 → 学习 → 深度研究/);
  assert.equal(pausedResearchNote(store, 's1', state), undefined, 'once');
  const busy = store.createResearchJob({ topic: 'Running again', depth: 'quick', sessionId: 's2' });
  store.setResearchStatus({ id: busy.id, status: 'paused' });
  assert.equal(pausedResearchNote(store, 's2', { running: new Map([[busy.id, {}]]), told: new Set() }), undefined, 'not while it runs');
  store.close();
});

test('every deep_research result is lossless JSON', async () => {
  const p = plugin();
  const start = await p.research.tool.execute({ action: 'start', topic: 'Lossless', depth: 'quick' }, { agent });
  await p.started.at(-1)?.hooks.done;
  for (const value of [
    start,
    await p.research.tool.execute({ action: 'status', id: start.job.id }, { agent }),
    await p.research.tool.execute({ action: 'report', id: start.job.id }, { agent }),
    await p.research.tool.execute({ action: 'list' }, { agent }),
    await p.research.tool.execute({ action: 'resume', id: start.job.id }, { agent }),
  ]) {
    assert.ok(isRemoteJsonValue(value), JSON.stringify(value).slice(0, 300));
  }
  p.dispose();
});

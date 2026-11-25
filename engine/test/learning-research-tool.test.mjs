import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import { TOOL, researchTools, sessionTarget } from '../plugins/learning/research-tool.mjs';
import { LearningStore } from '../plugins/learning/store.mjs';

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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  DEPTHS, checkCitations, citationOrder, numberCitations, parseJson, runResearch, topicSimilarity,
} from '../plugins/learning/research.mjs';
import { APPLICATION_ID, LearningStore, MIGRATIONS, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

// A deterministic stand-in for the model: it answers each kind of prompt the way a model would,
// from what the prompt contains. `verdict` and `gaps` can be changed per test.
function fakeModel({ verdict = 'corroborated', gapRounds = 1, abortAt, controller, onCall } = {}) {
  let calls = 0;
  let gapsAsked = 0;
  const llm = async ({ system, user }) => {
    calls += 1;
    onCall?.(calls, system);
    if (abortAt && calls === abortAt) {
      controller.abort();
      throw new Error('the engine stopped');
    }
    if (system.startsWith('You plan')) return '```json\n{"subtopics":[{"title":"History of the abacus","overview":"origins"},{"title":"How the abacus works","overview":"mechanics"}]}\n```';
    if (system.startsWith('You research')) {
      const cit = /\[(CIT-[\w-]+)\]/.exec(user)?.[1];
      if (!cit) return `{"action":"search","query":"${/Your sub-topic: ([^—]+)/.exec(system)[1].trim()}"}`;
      return JSON.stringify({ action: 'finish', summary: `The abacus is about 2,500 years old [${cit}]. Made up [CIT-nope].` });
    }
    if (system.startsWith('Summarise one tool result')) return 'A dense note about the result.';
    if (system.startsWith('From the research summaries')) {
      const cit = /\[(CIT-[\w-]+)\]/.exec(user)?.[1];
      return JSON.stringify({ claims: [{ claim: 'The abacus is about 2,500 years old', citations: [cit] }] });
    }
    if (system.startsWith('Judge one claim')) {
      const cits = [...user.matchAll(/\[(CIT-[\w-]+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ status: verdict, note: 'checked', citations: cits.slice(0, 2) });
    }
    if (system.startsWith('Review a research run')) {
      gapsAsked += 1;
      return gapsAsked <= gapRounds ? '{"gaps":[{"title":"Abacus in modern schools","overview":"use today","why":"missing"}]}' : '{"gaps":[]}';
    }
    if (system.startsWith('Plan a research report')) {
      const ids = [...user.matchAll(/^(B\d+) /gm)].map((m) => m[1]);
      return JSON.stringify({ title: 'The abacus', sections: [{ title: 'Origins', intent: 'where it came from', blocks: ids.slice(0, 1) }] });
    }
    if (system.startsWith('Write section')) {
      const n = /section (\d+)/.exec(system)[1];
      const cits = [...user.matchAll(/\[(CIT-[\w-]+)\]/g)].map((m) => m[1]);
      return `## ${n}. Section\nFinding one [${cits[0]}]. Finding two [${cits[1] ?? cits[0]}]. Invented [CIT-ghost].`;
    }
    if (system.startsWith('Write the opening summary')) return '## Summary\nThe abacus is old.';
    if (system.startsWith('Summarise what the evidence')) return '{"summary":"Nothing conclusive."}';
    throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
  };
  return { llm, calls: () => calls };
}

function fakeTools() {
  const used = [];
  return {
    used,
    tools: {
      search: async (query) => {
        used.push(['search', query]);
        return { results: [1, 2].map((n) => ({ title: `${query} source ${n}`, url: `https://example.com/${encodeURIComponent(query)}/${n}`, snippet: `About ${query} (${n})` })) };
      },
      kb: async (query) => {
        used.push(['kb', query]);
        return { results: [{ label: '《Notes》第 1/1 段', excerpt: `My notes on ${query}`, documentTitle: 'Notes', chunkId: 7 }] };
      },
    },
  };
}

const newJob = (store, extra = {}) => store.createResearchJob({ topic: 'The history and use of the abacus', depth: 'quick', ...extra });

// Helpers

test('parseJson finds the first JSON value, fenced or not, with braces inside strings', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! {"a":"x}y","b":[1,2]} trailing'), { a: 'x}y', b: [1, 2] });
  assert.deepEqual(parseJson('[1,{"x":2}]'), [1, { x: 2 }]);
  assert.equal(parseJson('no json here'), undefined);
  assert.equal(parseJson('{"broken":'), undefined);
  assert.equal(parseJson(undefined), undefined);
});

test('topic similarity catches near-duplicates in English and Chinese', () => {
  assert.ok(topicSimilarity('History of the abacus', 'The abacus: its history') >= 0.8);
  assert.ok(topicSimilarity('算盘的历史', '算盘历史') >= 0.8);
  assert.ok(topicSimilarity('History of the abacus', 'Modern calculators') < 0.5);
});

test('citations: unknown ids removed, numbered by first appearance, references listed', () => {
  const known = new Map([['CIT-a', { title: 'A', url: 'https://a' }], ['CIT-b', { title: 'B', label: '《B》第 1/2 段' }]]);
  const { text, unknown } = checkCitations('x [CIT-b] y [CIT-z] z [CIT-a]', new Set(known.keys()));
  assert.deepEqual(unknown, ['CIT-z']);
  assert.equal(text, 'x [CIT-b] y z [CIT-a]');
  assert.deepEqual(citationOrder(text), ['CIT-b', 'CIT-a']);
  const { body, references } = numberCitations('p [CIT-b] q [CIT-a] r [CIT-b]', known);
  assert.equal(body, 'p [1] q [2] r [1]');
  assert.deepEqual(references, ['1. B — 《B》第 1/2 段', '2. A — https://a']);
});

// A full run

test('a full run: plan, research with citations, claim check, gap round, cited report', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const model = fakeModel();
  const { tools, used } = fakeTools();
  const progress = [];
  const done = await runResearch(store, job.id, { llm: model.llm, tools, onProgress: (line) => progress.push(line) });
  assert.equal(done.status, 'done', done.error ?? '');
  const blocks = store.listResearchBlocks({ jobId: job.id });
  assert.deepEqual(blocks.map((b) => [b.origin, b.status]), [['plan', 'done'], ['plan', 'done'], ['gap', 'done']]);
  assert.ok(blocks.every((b) => !b.summary.includes('CIT-nope')), 'invented ids are removed from block summaries');
  assert.ok(used.some(([name]) => name === 'search'));
  assert.ok(used.some(([, q]) => q === 'The abacus is about 2,500 years old'), 'the claim was searched for independently');
  const claims = store.listClaims({ jobId: job.id });
  assert.equal(claims[0].status, 'corroborated');
  assert.ok(claims[0].citations.length >= 1);
  const report = done.report;
  assert.match(report, /^# The abacus/);
  assert.match(report, /## Summary/);
  assert.match(report, /## 1\. Section\nFinding one \[1\]\./);
  assert.doesNotMatch(report, /CIT-/, 'every marker became a number or was removed');
  assert.match(report, /## Claim checks\n\n- \*\*corroborated\*\*/);
  assert.match(report, /## References\n\n1\. .+ — https:\/\/example\.com\//);
  assert.ok(progress.includes('done'));
  assert.ok(done.callsUsed <= DEPTHS.quick.calls);
  assert.equal(store.listResearchSteps({ jobId: job.id }).filter((s) => s.kind === 'llm').length, done.callsUsed);
  // A finished job is not run again.
  const again = fakeModel();
  assert.equal((await runResearch(store, job.id, { llm: again.llm, tools })).status, 'done');
  assert.equal(again.calls(), 0);
  store.close();
});

test('stopped at any step, the run resumes from there: same report, nothing written twice', async () => {
  const reference = new LearningStore(':memory:');
  const refJob = newJob(reference);
  const refModel = fakeModel();
  const expected = (await runResearch(reference, refJob.id, { llm: refModel.llm, tools: fakeTools().tools })).report;
  const total = refModel.calls();
  const refCitations = reference.listCitations({ jobId: refJob.id }).length;
  reference.close();
  assert.ok(total > 10);
  for (let stopAt = 1; stopAt <= total; stopAt += 1) {
    const store = new LearningStore(':memory:');
    const job = newJob(store);
    const controller = new AbortController();
    const first = fakeModel({ abortAt: stopAt, controller });
    const paused = await runResearch(store, job.id, { llm: first.llm, tools: fakeTools().tools, signal: controller.signal });
    assert.equal(paused.status, 'paused', `stop at ${stopAt}`);
    // Resume twice: the first finishes, the second finds nothing to do.
    const second = fakeModel();
    const done = await runResearch(store, job.id, { llm: second.llm, tools: fakeTools().tools });
    assert.equal(done.status, 'done', `stop at ${stopAt}: ${done.error ?? ''}`);
    assert.equal(done.report, expected, `stop at ${stopAt}: the same report`);
    assert.equal(first.calls() - 1 + second.calls(), total, `stop at ${stopAt}: no model call repeated`);
    assert.equal(store.listCitations({ jobId: job.id }).length, refCitations, `stop at ${stopAt}: no duplicate citations`);
    const third = fakeModel();
    await runResearch(store, job.id, { llm: third.llm, tools: fakeTools().tools });
    assert.equal(third.calls(), 0);
    store.close();
  }
});

test('cancel: the job ends cancelled after the current step and keeps what it finished', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const model = fakeModel({ onCall: (n) => { if (n === 4) store.cancelResearch({ id: job.id }); } });
  const result = await runResearch(store, job.id, { llm: model.llm, tools: fakeTools().tools });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.report, null);
  assert.ok(store.listResearchSteps({ jobId: job.id }).length >= 4);
  assert.equal(model.calls(), 4, 'no model call after the cancel');
  assert.equal((await runResearch(store, job.id, { llm: fakeModel().llm, tools: fakeTools().tools })).status, 'cancelled');
  // A job that is not running is cancelled at once.
  const idle = newJob(store);
  assert.equal(store.cancelResearch({ id: idle.id }).status, 'cancelled');
  store.close();
});

test('a conflicting claim opens a new sub-topic to resolve it', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const done = await runResearch(store, job.id, { llm: fakeModel({ verdict: 'conflicting', gapRounds: 0 }).llm, tools: fakeTools().tools });
  assert.equal(done.status, 'done');
  const verify = store.listResearchBlocks({ jobId: job.id }).filter((b) => b.origin === 'verify');
  assert.equal(verify.length, 1);
  assert.match(verify[0].title, /^Conflicting evidence: /);
  assert.equal(verify[0].status, 'done');
  assert.match(done.report, /\*\*conflicting\*\*/);
});

test('search results are their own notes: no model call per result', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  let noteCalls = 0;
  const model = fakeModel({ onCall: (_n, system) => { if (system.startsWith('Summarise one tool result')) noteCalls += 1; } });
  const done = await runResearch(store, job.id, { llm: model.llm, tools: fakeTools().tools });
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(noteCalls, 0);
  const cits = store.listCitations({ jobId: job.id });
  assert.ok(cits.some((c) => c.note) && cits.every((c) => !c.note?.startsWith('A dense note')), 'the excerpt is the note');
  store.close();
});

test('a page that cannot be read costs no model call, is not cited, and the report says how many', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const base = fakeModel();
  let asked = 0;
  let noteCalls = 0;
  const llm = async (prompt) => {
    if (prompt.system.startsWith('Summarise one tool result')) noteCalls += 1;
    if (prompt.system.startsWith('You research') && asked < 2) {
      asked += 1;
      return JSON.stringify({ action: 'fetch', url: `https://blocked.example/${asked}` });
    }
    return base.llm(prompt);
  };
  const { tools } = fakeTools();
  tools.fetch = async (url) => (url.endsWith('/1') ? { url, title: url, text: '请登录' } : { error: 'unsupported charset "gbk"' });
  const done = await runResearch(store, job.id, { llm, tools });
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(noteCalls, 0);
  assert.ok(store.listCitations({ jobId: job.id }).every((c) => !c.url?.startsWith('https://blocked.example/')));
  assert.match(done.report, /2 web pages could not be read/);
  store.close();
});

test('the model-call budget stops expansion, and the report is still written and says so', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const saved = DEPTHS.quick.calls;
  DEPTHS.quick.calls = 6;
  try {
    const done = await runResearch(store, job.id, { llm: fakeModel().llm, tools: fakeTools().tools });
    assert.equal(done.status, 'done', done.error ?? '');
    assert.match(done.report, /model-call budget/);
    const researchCalls = store.listResearchSteps({ jobId: job.id }).filter((s) => s.kind === 'llm' && !s.key.startsWith('report:')).length;
    assert.ok(researchCalls <= 6, `${researchCalls} research calls`);
  } finally {
    DEPTHS.quick.calls = saved;
  }
});

test('knowledge-base only: citations carry the document position; no sources at all fails clearly', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store, { sources: ['kb'] });
  const { tools } = fakeTools();
  const done = await runResearch(store, job.id, { llm: fakeModel({ gapRounds: 0 }).llm, tools: { kb: tools.kb } });
  assert.equal(done.status, 'done', done.error ?? '');
  const cit = store.listCitations({ jobId: job.id })[0];
  assert.deepEqual({ tool: cit.tool, label: cit.label, chunkId: cit.chunkId }, { tool: 'kb', label: '《Notes》第 1/1 段', chunkId: 7 });
  assert.match(done.report, /《Notes》第 1\/1 段/);
  const none = newJob(store);
  const failed = await runResearch(store, none.id, { llm: fakeModel().llm, tools: {} });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /no research source/);
});

test('a model that fails outright leaves the job failed with the reason', async () => {
  const store = new LearningStore(':memory:');
  const job = newJob(store);
  const failed = await runResearch(store, job.id, { llm: async () => { throw new Error('401 bad key'); }, tools: fakeTools().tools });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /401 bad key/);
});

test('jobs: validation, listing, interrupted jobs pause at start, delete removes everything', () => {
  const store = new LearningStore(':memory:');
  assert.throws(() => store.createResearchJob({ topic: ' ' }), { kind: 'invalid' });
  assert.throws(() => store.createResearchJob({ topic: 'x', depth: 'huge' }), { kind: 'invalid' });
  assert.throws(() => store.createResearchJob({ topic: 'x', sources: ['web', 'tv'] }), { kind: 'invalid' });
  const a = store.createResearchJob({ topic: 'a', sessionId: 's1' });
  store.setResearchStatus({ id: a.id, status: 'running', phase: 'researching', progress: '1/2' });
  assert.deepEqual(store.pauseInterruptedResearch(), { paused: 1 });
  assert.equal(store.getResearchJob({ id: a.id }).status, 'paused');
  assert.equal(store.listResearchJobs()[0].sessionId, 's1');
  store.addResearchBlocks({ jobId: a.id, origin: 'plan', blocks: [{ title: 't' }] });
  store.putResearchStep({ jobId: a.id, key: 'k', kind: 'llm', output: 'x' });
  store.deleteResearchJob({ id: a.id });
  for (const table of ['research_blocks', 'research_steps', 'research_citations', 'research_claims']) {
    assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  }
  store.close();
});

test('a schema 5 library opens at schema 6 with its data intact', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-research-')), 'learning.db');
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 5)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 5`);
  db.prepare("INSERT INTO quiz_questions(kind, prompt, answer, created_at) VALUES ('short', 'kept?', 'yes', 1)").run();
  db.close();
  const store = new LearningStore(file);
  assert.ok(SCHEMA_VERSION >= 6);
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.listQuestions()[0].prompt, 'kept?');
  assert.deepEqual(store.listResearchJobs(), []);
  store.close();
});

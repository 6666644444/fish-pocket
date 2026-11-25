import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import { APPLE_PREFIX, appleEmbedder, appleQueryVectors, embedPending, modelLanguage } from '../plugins/learning/embed.mjs';
import { LearningStore } from '../plugins/learning/store.mjs';

/**
 * A stand-in for the dsh_ios_native addon's nlp.language / nlp.vectors. Its "embedding" puts
 * each text on two axes, fruit and vehicles, so rankings are predictable. `languages` are the
 * ones the device has a sentence embedding for.
 */
function fakeAddon({ languages = ['zh-Hans', 'en'], revision = 1 } = {}) {
  const calls = [];
  const axis = (text) => [/(苹果|香蕉|水果|fruit|apple)/i.test(text) ? 1 : 0, /(汽车|汽油|car|fuel)/i.test(text) ? 1 : 0];
  const call = async (capability, op, args, caller) => {
    calls.push({ capability, op, args, caller });
    assert.equal(capability, 'nlp');
    if (op === 'language') return { language: /[\p{Script=Han}]/u.test(args.text) ? 'zh-Hans' : 'en' };
    if (op === 'vectors') {
      const language = args.language;
      if (!languages.includes(language)) return { available: false, language };
      return {
        available: true, language, dimension: 2, revision, model: `apple-nl-sentence/${language}/r${revision}`,
        vectors: args.texts.map((text) => (/^[\s#*]*$/.test(text) ? null : axis(text))),
      };
    }
    throw new Error(`unexpected op ${op}`);
  };
  return { calls, embedder: appleEmbedder({ caps: () => ({ nlp: ['language', 'entities', 'similar', 'vectors'] }), call }) };
}

const zhDoc = ['苹果是一种水果，富含维生素。', '香蕉是黄色的水果。', '汽车需要汽油才能行驶。'].map((s) => s.repeat(40)).join('\n');

test('no addon, or an addon without nlp.vectors: no embedder', () => {
  assert.equal(appleEmbedder({ caps: () => null }), null);
  assert.equal(appleEmbedder({ caps: () => ({ nlp: ['language', 'similar'] }) }), null);
  assert.equal(appleEmbedder({ caps: () => ({}) }), null);
});

test('model names carry the language and the revision', () => {
  assert.equal(modelLanguage('apple-nl-sentence/zh-Hans/r1'), 'zh-Hans');
  assert.equal(modelLanguage('openai/text-embedding-3-small'), null);
  assert.ok('apple-nl-sentence/en/r2'.startsWith(APPLE_PREFIX));
});

test('embedPending: detects the language once, embeds in batches, marks the document ok', async () => {
  const { calls, embedder } = fakeAddon();
  const store = new LearningStore(':memory:');
  const doc = store.importDocument({ title: '笔记', kind: 'txt', text: zhDoc });
  const result = await embedPending(store, embedder, { batch: 2 });
  assert.equal(result.stored, doc.chunkCount);
  const after = store.getDocument({ id: doc.id });
  assert.deepEqual({ language: after.language, status: after.embeddingStatus }, { language: 'zh-Hans', status: 'ok' });
  assert.equal(calls.filter((c) => c.op === 'language').length, 1);
  assert.ok(calls.filter((c) => c.op === 'vectors').every((c) => c.args.texts.length <= 2 && c.args.language === 'zh-Hans'));
  assert.ok(calls.every((c) => c.caller === 'learning'));
  assert.deepEqual(store.vectorModels(), [{ model: 'apple-nl-sentence/zh-Hans/r1', dims: 2 }]);
  assert.deepEqual(await embedPending(store, embedder), { stored: 0, documents: 0 }, 'nothing left to do');
  store.close();
});

test('a language the device has no embedding for is marked unavailable and not retried', async () => {
  const { calls, embedder } = fakeAddon({ languages: ['en'] });
  const store = new LearningStore(':memory:');
  const doc = store.importDocument({ title: '笔记', kind: 'txt', text: zhDoc });
  assert.equal((await embedPending(store, embedder)).stored, 0);
  assert.equal(store.getDocument({ id: doc.id }).embeddingStatus, 'unavailable');
  const before = calls.length;
  assert.deepEqual(await embedPending(store, embedder), { stored: 0, documents: 0 });
  assert.equal(calls.length, before, 'no call for a document that cannot succeed');
  store.close();
});

test('chunks the embedding cannot place get no vector and do not stall the run', async () => {
  const { embedder } = fakeAddon();
  const store = new LearningStore(':memory:');
  const doc = store.importDocument({ title: 'md', kind: 'md', text: `# ${'#'.repeat(3)}\n\n${'*'.repeat(900)}\n\n# 水果\n\n${'苹果是水果。'.repeat(50)}` });
  const result = await embedPending(store, embedder, { batch: 1 });
  assert.ok(result.stored >= 1);
  assert.ok(result.stored < doc.chunkCount, 'the symbol-only chunk has no vector');
  assert.equal(store.getDocument({ id: doc.id }).embeddingStatus, 'ok');
  store.close();
});

test('a failing addon marks the document failed and reports the error; an aborted run stops', async () => {
  const store = new LearningStore(':memory:');
  const doc = store.importDocument({ title: 'x', kind: 'txt', text: zhDoc });
  const broken = appleEmbedder({ caps: () => ({ nlp: ['language', 'vectors'] }), call: async () => { throw new Error('addon crashed'); } });
  await assert.rejects(embedPending(store, broken), /addon crashed/);
  assert.equal(store.getDocument({ id: doc.id }).embeddingStatus, 'failed');
  const other = store.importDocument({ title: 'y', kind: 'txt', text: zhDoc });
  const stop = new AbortController();
  stop.abort();
  assert.deepEqual(await embedPending(store, fakeAddon().embedder, { signal: stop.signal }), { stored: 0, documents: 0 });
  assert.equal(store.getDocument({ id: other.id }).embeddingStatus, '');
  store.close();
});

test('appleQueryVectors embeds the query once per Apple model present', async () => {
  const { calls, embedder } = fakeAddon();
  const store = new LearningStore(':memory:');
  store.importDocument({ title: 'zh', kind: 'txt', text: zhDoc });
  store.importDocument({ title: 'en', kind: 'txt', text: 'An apple is a fruit. A car needs fuel. '.repeat(30) });
  await embedPending(store, embedder);
  store.putVectors({ model: 'openai/x', items: [{ chunkId: 1, vector: [1, 0, 0] }] });
  const start = calls.length;
  const vectors = await appleQueryVectors(store, embedder, '水果');
  assert.deepEqual(vectors.map((v) => v.model).sort(), ['apple-nl-sentence/en/r1', 'apple-nl-sentence/zh-Hans/r1']);
  assert.equal(calls.length - start, 2, 'not for the openai model');
  // A device whose embedding moved to a new revision: old vectors are not compared with new ones.
  const newer = fakeAddon({ revision: 2 }).embedder;
  assert.deepEqual(await appleQueryVectors(store, newer, '水果'), []);
  store.close();
});

test('plugin: import starts indexing; search embeds the query and ranks by meaning too', async () => {
  const { embedder } = fakeAddon();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-embed-')), 'learning', 'learning.db');
  const routes = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  const plugin = new Learning(ctx, { file, embedder });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  const imported = await post('kb.documents.import', { title: '笔记', kind: 'txt', text: zhDoc });
  assert.equal(imported.status, 200);
  await plugin.indexing();
  const status = (await post('kb.status')).body.result;
  assert.deepEqual(status.appleEmbedding, { available: true, enabled: true });
  assert.equal(status.vectors.models[0].chunks, imported.body.result.chunkCount);
  const found = (await post('kb.search', { query: '维生素', limit: 50 })).body.result;
  assert.equal(found.mode, 'hybrid');
  assert.match(found.results[0].excerpt, /苹果/);
  assert.ok(found.results.some((r) => r.excerpt.includes('香蕉')), 'found by meaning without the keyword');
  // Turned off: keyword only, and nothing is embedded.
  await post('settings.update', { appleEmbedding: false });
  assert.equal((await post('kb.search', { query: '维生素' })).body.result.mode, 'fts');
  assert.deepEqual((await post('kb.vectors.index')).body.result, { started: false });
  disposers.reverse().forEach((d) => d());
});

test('plugin without the addon: search is keyword only and kb.status says so', async () => {
  const routes = new Map();
  const ctx = { effect: (run) => run(), on: () => {}, connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => {}; } } } };
  new Learning(ctx, { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-noaddon-')), 'l.db'), embedder: null });
  const post = async (method, body) => (await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }))).json();
  await post('kb.documents.import', { title: 'a', kind: 'txt', text: '苹果是一种水果。'.repeat(30) });
  assert.equal((await post('kb.status')).result.appleEmbedding.available, false);
  assert.equal((await post('kb.search', { query: '苹果' })).result.mode, 'like');
});

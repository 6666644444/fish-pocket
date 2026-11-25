import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Learning, { METHODS, ROUTE, call } from '../plugins/learning/index.mjs';

/** A context that keeps the routes the plugin registers. */
function fakeContext(config) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  new Learning(ctx, config);
  return { routes, dispose: () => disposers.reverse().forEach((d) => d()) };
}

async function post(routes, method, body) {
  const route = routes.get(`${ROUTE}/${method}`);
  assert.ok(route, `route for ${method}`);
  assert.deepEqual(route.methods, ['POST']);
  const response = await route.fetch(new Request(`http://x${ROUTE}/${method}`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  }));
  return { status: response.status, body: await response.json() };
}

const library = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-plugin-')), 'learning', 'learning.db');

test('every method has a route under /api/learning, and they go away on dispose', () => {
  const { routes, dispose } = fakeContext({ file: library() });
  assert.deepEqual([...routes.keys()].sort(), Object.keys(METHODS).map((m) => `${ROUTE}/${m}`).sort());
  dispose();
  assert.equal(routes.size, 0);
});

test('nothing is opened until the first request', () => {
  const file = library();
  const { dispose } = fakeContext({ file });
  assert.equal(fs.existsSync(path.dirname(file)), false);
  dispose();
});

test('a round trip over the routes', async () => {
  const file = library();
  const { routes, dispose } = fakeContext({ file });
  const status = await post(routes, 'status');
  assert.equal(status.status, 200);
  assert.equal(status.body.result.search, 'trigram');
  assert.ok(fs.existsSync(file));

  const book = (await post(routes, 'notebooks.create', { title: '化学' })).body.result;
  const note = (await post(routes, 'notes.create', { notebookId: book.id, title: '氧化还原', body: '失电子被氧化' })).body.result;
  assert.equal(note.notebookId, book.id);
  const found = await post(routes, 'notes.search', { query: '被氧化' });
  assert.deepEqual(found.body.result.results.map((r) => r.id), [note.id]);
  const memory = (await post(routes, 'memories.create', { content: '化学方程式要配平' })).body.result;
  assert.equal((await post(routes, 'memories.update', { id: memory.id, content: '先配平再写条件' })).body.result.content, '先配平再写条件');
  assert.deepEqual((await post(routes, 'memories.clear')).body.result, { deleted: 1 });
  assert.equal((await post(routes, 'notes.get', { id: note.id })).status, 200, 'clearing memories leaves notes');
  dispose();
});

test('errors carry a kind and the matching status', async () => {
  const { routes, dispose } = fakeContext({ file: library() });
  assert.deepEqual(await post(routes, 'notes.get', '{not json'), {
    status: 400, body: { error: { kind: 'invalid', message: 'the body is not JSON' } },
  });
  assert.equal((await post(routes, 'notes.get', [])).status, 400);
  assert.equal((await post(routes, 'notes.get', { id: 'x' })).body.error.kind, 'invalid');
  const missing = await post(routes, 'notebooks.get', { id: 42 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.kind, 'not-found');
  dispose();
});

test('a library that cannot be opened answers 409 or 503, not a crash', async () => {
  const file = library();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'this is not sqlite');
  const { routes, dispose } = fakeContext({ file });
  const answer = await post(routes, 'status');
  assert.ok([409, 500, 503].includes(answer.status));
  assert.ok(answer.body.error.message);
  dispose();
  const unknown = call(() => { throw new Error('never'); }, 'nope', {});
  assert.equal(unknown.status, 404);
});

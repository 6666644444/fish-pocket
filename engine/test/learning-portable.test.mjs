import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import {
  EXPORT_FORMAT, BEFORE_RESTORE, backupLibrary, documentText, dumpLibrary, exportLibrary, importExport, importLibrary, inspectBackup,
  isEmpty, listBackups, safeName, stamp,
} from '../plugins/learning/portable.mjs';
import { LearningStore, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A library with something in every part. */
function filled(store) {
  let now = 1_000;
  store.now = () => (now += 7);
  const book = store.createNotebook({ title: '高中数学/代数' });
  store.createNote({ notebookId: book.id, title: '二次函数', body: '图像是抛物线。' });
  store.createNote({ notebookId: book.id, title: '二次函数', body: '同名的第二条。' });
  store.createNote({ notebookId: store.createNotebook({ title: 'English' }).id, title: '', body: 'untitled note' });
  store.createMemory({ content: '喜欢先看例题' });
  store.updateSettings({ injectMemories: false });
  store.setSessionMode({ sessionId: 'sess-1', mode: 'socratic' });
  store.importDocument({ title: '讲义', kind: 'md', text: `# 导数\n\n${'导数是函数的瞬时变化率。'.repeat(120)}\n\n# 积分\n\n积分是导数的逆运算。` });
  const [c] = store.saveQuestions({ questions: [{ kind: 'choice', prompt: '2+2?', options: ['3', '4'], answer: 'B', topic: '算术' }] });
  store.answerQuestion({ id: c.id, answer: 'A' });
  const job = store.createResearchJob({ topic: '算盘的历史', depth: 'quick' });
  store.addCitations({ jobId: job.id, blockId: null, tool: 'search', query: 'q', stepKey: 'plan', items: [{ title: 'Src', url: 'https://x', raw: 'raw' }] });
  store.putClaim({ jobId: job.id, key: 'k', claim: '很古老', status: 'corroborated', note: 'n', citations: ['CIT-plan-1'] });
  store.finishResearch({ id: job.id, status: 'done', report: '# 报告\n\n算盘很古老 [1]。' });
  return store;
}

/** A dump without timestamps the import cannot keep (research jobs keep theirs). */
const comparable = (dump) => JSON.parse(JSON.stringify(dump));

test('safe names and document text from overlapping chunks', () => {
  assert.equal(safeName('高中数学/代数'), '高中数学_代数');
  assert.equal(safeName('  ..hidden  '), 'hidden');
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName('a:b*c?'), 'a_b_c_');
  const text = 'abcdefghij';
  assert.equal(documentText([{ start: 0, end: 6, text: 'abcdef' }, { start: 4, end: 10, text: 'efghij' }]), text);
  assert.equal(documentText([]), '');
});

test('a document comes back exactly from its chunks', () => {
  const store = new LearningStore(':memory:');
  const original = `# 导数\n\n${'导数是函数的瞬时变化率。'.repeat(120)}\n\nEnglish too. ${'More words here. '.repeat(80)}`;
  store.importDocument({ title: 't', kind: 'md', text: original });
  assert.equal(dumpLibrary(store).documents[0].text, original);
  store.close();
});

test('export writes notes as Markdown, reports as Markdown and everything as data.json', () => {
  const dir = temp('dsh-learning-export-');
  const store = filled(new LearningStore(':memory:'));
  const result = exportLibrary(store, dir, Date.UTC(2026, 10, 25, 9, 30));
  assert.equal(path.basename(result.path), 'learning-export-2026-11-25-09-30-00');
  assert.deepEqual({ n: result.notes, b: result.notebooks, d: result.documents, q: result.questions, r: result.research }, { n: 3, b: 2, d: 1, q: 1, r: 1 });
  const notes = path.join(result.path, 'notes');
  assert.deepEqual(fs.readdirSync(notes).sort(), ['English', '高中数学_代数']);
  assert.deepEqual(fs.readdirSync(path.join(notes, '高中数学_代数')).sort(), ['二次函数 (2).md', '二次函数.md']);
  assert.equal(fs.readFileSync(path.join(notes, '高中数学_代数', '二次函数.md'), 'utf8'), '# 二次函数\n\n图像是抛物线。\n');
  assert.deepEqual(fs.readdirSync(path.join(notes, 'English')), ['note.md']);
  assert.equal(fs.readFileSync(path.join(result.path, 'research', '算盘的历史.md'), 'utf8'), '# 报告\n\n算盘很古老 [1]。\n');
  const data = JSON.parse(fs.readFileSync(path.join(result.path, 'data.json'), 'utf8'));
  assert.equal(data.format, EXPORT_FORMAT);
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.ok(fs.existsSync(path.join(result.path, 'README.md')));
  store.close();
});

test('export then import into an empty library gives the same data', () => {
  const dir = temp('dsh-learning-roundtrip-');
  const source = filled(new LearningStore(':memory:'));
  const before = comparable(dumpLibrary(source));
  const { path: folder } = exportLibrary(source, dir);
  const target = new LearningStore(':memory:');
  assert.ok(isEmpty(target));
  assert.deepEqual(importExport(target, folder), { imported: true });
  const after = comparable(dumpLibrary(target));
  assert.deepEqual(after, before);
  assert.equal(target.searchKnowledge({ query: '瞬时变化率' }).results.length > 0, true, 'the imported document is searchable');
  assert.equal(target.listQuestions({ mistakes: true }).length, 1, 'the mistake book came back');
  assert.equal(target.getSettings().injectMemories, false);
  // A library that already holds data refuses, and stays as it was.
  assert.throws(() => importExport(target, folder), { kind: 'conflict' });
  assert.deepEqual(comparable(dumpLibrary(target)), before);
  source.close();
  target.close();
});

test('import refuses what is not an export, a newer format, and broken references, writing nothing', () => {
  const store = new LearningStore(':memory:');
  assert.throws(() => importLibrary(store, { hello: 1 }), { kind: 'invalid' });
  assert.throws(() => importLibrary(store, { format: EXPORT_FORMAT, version: 99 }), { kind: 'conflict' });
  assert.throws(() => importLibrary(store, { format: EXPORT_FORMAT, version: 1, notebooks: [], notes: [{ notebook: 3, title: 'x', body: '' }] }), { kind: 'invalid' });
  assert.ok(isEmpty(store));
  assert.throws(() => importExport(store, temp('dsh-learning-noexport-')), { kind: 'invalid' });
  store.close();
});

test('backup: a consistent copy; inspection checks application id and schema version', () => {
  const dir = temp('dsh-learning-backup-');
  const store = filled(new LearningStore(path.join(dir, 'learning.db')));
  const backup = backupLibrary(store, dir, Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(backup.name, 'learning-2026-01-02-03-04-05.db');
  assert.equal(backup.kind, 'manual');
  assert.deepEqual(inspectBackup(backup.path), { schemaVersion: SCHEMA_VERSION });
  assert.deepEqual(listBackups(dir).map((b) => b.name), [backup.name]);
  assert.equal(backupLibrary(store, dir, Date.UTC(2026, 0, 2, 3, 4, 5)).name, 'learning-2026-01-02-03-04-05-2.db', 'the same second gets a new name');
  const copy = new LearningStore(backup.path);
  assert.deepEqual(comparable(dumpLibrary(copy)), comparable(dumpLibrary(store)));
  copy.close();
  // Not ours, and newer than this app: both refused.
  const other = path.join(dir, 'other.db');
  const db = new DatabaseSync(other);
  db.exec('CREATE TABLE x (y)');
  db.close();
  assert.throws(() => inspectBackup(other), { kind: 'invalid' });
  const newer = path.join(dir, 'newer.db');
  fs.copyFileSync(backup.path, newer);
  const n = new DatabaseSync(newer);
  n.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  n.close();
  assert.throws(() => inspectBackup(newer), { kind: 'conflict' });
  const text = path.join(dir, 'notes.txt');
  fs.writeFileSync(text, 'not sqlite');
  assert.throws(() => inspectBackup(text), { kind: 'invalid' });
  assert.throws(() => inspectBackup(path.join(dir, 'missing.db')), { kind: 'not-found' });
  store.close();
});

// The plugin, on a fake $DSH_HOME

function listFiles(root, skip) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (rel === skip || rel.startsWith(`${skip}${path.sep}`)) continue;
      if (entry.isDirectory()) walk(full);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function plugin(home) {
  const routes = new Map();
  const ctx = {
    effect: (run) => run(), on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
    tools: { register: () => () => {} },
  };
  const instance = new Learning(ctx, { file: path.join(home, 'learning', 'learning.db'), embedder: null, skillsDir: path.join(home, 'skills'), services: {} });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  return { instance, post };
}

function fakeHome() {
  const home = temp('dsh-learning-home-');
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'a.jsonl'), '{"turn":1}\n');
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'bot.json'), '{}');
  fs.mkdirSync(path.join(home, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: d\n---\nbody\n');
  return home;
}

test('one-click delete: the learning library is empty after, nothing else in $DSH_HOME changed', async () => {
  const home = fakeHome();
  const { post } = plugin(home);
  await post('notebooks.create', { title: 'n' });
  await post('memories.create', { content: 'm' });
  await post('kb.documents.import', { title: 'd', kind: 'txt', text: '一些资料。'.repeat(50) });
  await post('backup.create');
  await post('data.export');
  const others = listFiles(home, 'learning');
  assert.ok(Object.keys(others).length >= 4);
  assert.equal((await post('data.summary')).body.result.notebooks, 1);
  assert.equal((await post('data.delete', {})).status, 400, 'needs the confirmation word');
  assert.equal((await post('data.delete', { confirm: 'yes' })).status, 400);
  assert.deepEqual((await post('data.delete', { confirm: 'delete-learning-data' })).body.result, { deleted: true });
  assert.equal(fs.existsSync(path.join(home, 'learning')), false, 'library, exports and backups are gone');
  assert.deepEqual(listFiles(home, 'learning'), others, 'every other file is byte for byte the same');
  // The library opens again, empty.
  const summary = (await post('data.summary')).body.result;
  assert.deepEqual(summary, { notebooks: 0, notes: 0, memories: 0, documents: 0, questions: 0, mistakes: 0, research: 0 });
});

test('restore: a backup replaces the library, the current one is kept as a backup first', async () => {
  const home = fakeHome();
  const { post } = plugin(home);
  await post('notebooks.create', { title: 'before' });
  const backup = (await post('backup.create')).body.result;
  await post('notebooks.create', { title: 'after' });
  assert.equal((await post('notebooks.list')).body.result.length, 2);
  assert.equal((await post('backup.restore', { name: '../../settings.json' })).status, 404, 'only names in backups/');
  const restored = (await post('backup.restore', { name: backup.name })).body.result;
  assert.equal(restored.restored, backup.name);
  assert.ok(restored.previous);
  assert.deepEqual((await post('notebooks.list')).body.result.map((b) => b.title), ['before']);
  assert.equal((await post('backup.list')).body.result.length, 2, 'the replaced library is a backup now');
  // Restoring the safety copy brings "after" back.
  const back = (await post('backup.restore', { name: restored.previous })).body.result;
  assert.equal(back.restored, restored.previous);
  assert.equal((await post('notebooks.list')).body.result.length, 2);
});

test('names: the phone\'s local time when the app sends it, UTC otherwise; a bad one is ignored', () => {
  assert.equal(stamp(Date.UTC(2026, 10, 26, 17, 42, 17)), '2026-11-26-17-42-17');
  assert.equal(stamp(Date.UTC(2026, 10, 26, 17, 42, 17), '2026-11-27-01-42-17'), '2026-11-27-01-42-17');
  for (const bad of ['../x', '2026-11-27 01:42:17', '2026-11-27-01-42-17/..', 5]) {
    assert.equal(stamp(Date.UTC(2026, 10, 26, 17, 42, 17), bad), '2026-11-26-17-42-17');
  }
  const dir = temp('dsh-learning-local-');
  const store = new LearningStore(':memory:');
  assert.equal(backupLibrary(store, dir, 0, { local: '2026-11-27-01-42-17' }).name, 'learning-2026-11-27-01-42-17.db');
  assert.equal(path.basename(exportLibrary(store, dir, 0, { local: '2026-11-27-01-42-18' }).path), 'learning-export-2026-11-27-01-42-18');
  store.close();
});

test('backups list newest first by time, old UTC names and new local ones together', () => {
  const dir = temp('dsh-learning-order-');
  const store = new LearningStore(':memory:');
  const older = backupLibrary(store, dir, 0, { local: '2026-11-27-09-00-00' });
  const old = path.join(dir, 'backups', 'learning-20261126-150349.db');
  fs.copyFileSync(older.path, old);
  const t = Date.now() / 1000;
  fs.utimesSync(older.path, t - 200, t - 200);
  fs.utimesSync(old, t - 100, t - 100);
  const safety = backupLibrary(store, dir, 0, { local: '2026-11-27-08-00-00', tag: BEFORE_RESTORE });
  assert.equal(safety.kind, BEFORE_RESTORE);
  assert.deepEqual(listBackups(dir).map((b) => [b.name, b.kind]), [
    ['learning-2026-11-27-08-00-00-before-restore.db', BEFORE_RESTORE],
    ['learning-20261126-150349.db', 'manual'],
    ['learning-2026-11-27-09-00-00.db', 'manual'],
  ]);
  store.close();
});

test('a new export replaces the earlier ones: only the newest folder is kept', () => {
  const dir = temp('dsh-learning-exports-');
  const store = new LearningStore(':memory:');
  const first = exportLibrary(store, dir, 0, { local: '2026-11-27-01-00-00' }).path;
  fs.mkdirSync(path.join(dir, 'exports', 'kept-by-someone-else'));
  const second = exportLibrary(store, dir, 0, { local: '2026-11-27-01-00-05' }).path;
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'exports')).sort(), ['kept-by-someone-else', path.basename(second)].sort(), 'only export folders are removed');
  store.close();
});

test('deleting one backup: only an exact name from the list, nothing outside backups/', async () => {
  const home = fakeHome();
  const { post } = plugin(home);
  await post('notebooks.create', { title: 'x' });
  const a = (await post('backup.create', { local: '2026-11-27-01-00-00' })).body.result;
  const b = (await post('backup.create', { local: '2026-11-27-01-00-01' })).body.result;
  assert.equal('path' in a, false, 'the app is not given engine paths');
  for (const bad of ['../learning.db', `../backups/${a.name}`, 'learning.db', '', a.name.toUpperCase()]) {
    assert.equal((await post('backup.delete', { name: bad })).status, 404, bad);
  }
  assert.deepEqual((await post('backup.delete', { name: a.name })).body.result, { deleted: a.name });
  assert.deepEqual((await post('backup.list')).body.result.map((x) => x.name), [b.name]);
  assert.equal((await post('notebooks.list')).body.result.length, 1, 'the library is untouched');
  assert.equal((await post('backup.delete', { name: a.name })).status, 404, 'already gone');
});

test('the backup taken before a restore is marked as such', async () => {
  const home = fakeHome();
  const { post } = plugin(home);
  const backup = (await post('backup.create', { local: '2026-11-27-01-00-00' })).body.result;
  const restored = (await post('backup.restore', { name: backup.name, local: '2026-11-27-01-05-00' })).body.result;
  assert.equal(restored.previous, 'learning-2026-11-27-01-05-00-before-restore.db');
  const list = (await post('backup.list')).body.result;
  assert.deepEqual(list.map((x) => x.kind), ['before-restore', 'manual']);
  assert.ok(list.every((x) => Number.isInteger(x.createdAt)));
});

test('import over the route: data.json content into an empty library', async () => {
  const home = fakeHome();
  const source = filled(new LearningStore(':memory:'));
  const data = dumpLibrary(source);
  const { post } = plugin(home);
  assert.deepEqual((await post('data.import', { data })).body.result, { imported: true });
  assert.equal((await post('notebooks.list')).body.result.length, 2);
  assert.equal((await post('data.import', { data })).status, 409);
  source.close();
});

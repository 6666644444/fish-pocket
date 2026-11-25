import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { settingsFiles } from '../runtime/recovery.mjs';
import {
  APPLICATION_ID, LearningError, LearningStore, MIGRATIONS, SCHEMA_VERSION, excerpt, libraryFile, queryTerms,
} from '../plugins/learning/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-'));

/** A store whose clock ticks one millisecond per write, so orderings are stable. */
function memoryStore(options = {}) {
  let clock = 1_000;
  return new LearningStore(':memory:', { now: () => (clock += 1), ...options });
}

function seeded(options) {
  const store = memoryStore(options);
  const book = store.createNotebook({ title: '高中数学' });
  const other = store.createNotebook({ title: 'English' });
  store.createNote({ notebookId: book.id, title: '二次函数', body: '二次函数的图像是一条抛物线，开口方向由 a 决定。' });
  store.createNote({ notebookId: book.id, title: '数列', body: '等差数列的通项公式。Arithmetic sequence.' });
  store.createNote({ notebookId: other.id, title: 'Quadratic', body: 'A quadratic function graphs as a parabola. 函数 means function.' });
  store.createNote({ notebookId: other.id, title: 'Percent', body: 'Growth of 100% in a year.' });
  return { store, book, other };
}

const titles = (found) => found.results.map((r) => r.title).sort();

test('a new library is at the latest schema, marked as ours, with a trigram index', () => {
  const store = memoryStore();
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.db.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID);
  assert.notEqual(APPLICATION_ID, 1146308689, 'must differ from dsh-session-query-sqlite');
  assert.equal(store.fts, 'trigram');
  store.close();
});

test('a v1 library migrates to the latest schema and keeps its notes searchable', () => {
  const file = path.join(tmp(), 'learning.db');
  const db = new DatabaseSync(file);
  MIGRATIONS[0](db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
  db.exec("INSERT INTO notebooks(id, title, created_at, updated_at) VALUES (1, '旧本', 1, 1)");
  db.exec("INSERT INTO notes(notebook_id, title, body, created_at, updated_at) VALUES (1, '旧笔记', '牛顿第二定律 F=ma', 1, 1)");
  db.close();

  const store = new LearningStore(file);
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.listNotebooks()[0].noteCount, 1);
  const found = store.searchNotes({ query: '第二定律' });
  assert.equal(found.mode, 'fts');
  assert.deepEqual(titles(found), ['旧笔记']);
  store.close();
  const again = new LearningStore(file);
  assert.equal(again.version, SCHEMA_VERSION, 'opening twice does not migrate again');
  again.close();
});

test('a database that is not a learning library is refused and left alone', () => {
  const dir = tmp();
  const foreign = path.join(dir, 'other.db');
  const db = new DatabaseSync(foreign);
  db.exec('PRAGMA application_id = 1146308689; CREATE TABLE t(a)');
  db.close();
  assert.throws(() => new LearningStore(foreign), (e) => e instanceof LearningError && e.kind === 'conflict');

  const plain = path.join(dir, 'plain.db');
  const db2 = new DatabaseSync(plain);
  db2.exec('CREATE TABLE t(a)');
  db2.close();
  assert.throws(() => new LearningStore(plain), (e) => e.kind === 'conflict');
  const check = new DatabaseSync(plain);
  assert.equal(check.prepare('PRAGMA application_id').get().application_id, 0, 'untouched');
  check.close();
});

test('a library from a newer app is refused instead of being downgraded', () => {
  const file = path.join(tmp(), 'learning.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => new LearningStore(file), (e) => e.kind === 'conflict' && /newer/.test(e.message));
});

test('notebooks and notes: create, read, update, delete', () => {
  const store = memoryStore();
  const book = store.createNotebook({ title: '  物理  ' });
  assert.equal(book.title, '物理');
  const note = store.createNote({ notebookId: book.id, title: '力', body: 'F=ma' });
  assert.equal(store.getNotebook(book.id).noteCount, 1);
  const edited = store.updateNote({ id: note.id, body: 'F = m·a' });
  assert.equal(edited.title, '力', 'a field not sent stays');
  assert.equal(edited.body, 'F = m·a');
  assert.ok(edited.updatedAt > note.updatedAt);
  assert.equal(store.updateNotebook({ id: book.id, title: '力学' }).title, '力学');
  assert.deepEqual(store.listNotes({ notebookId: book.id }).map((n) => n.id), [note.id]);
  store.deleteNote({ id: note.id });
  assert.throws(() => store.getNote({ id: note.id }), (e) => e.kind === 'not-found');
  store.close();
});

test('deleting a notebook deletes its notes and nothing else', () => {
  const { store, book, other } = seeded();
  store.deleteNotebook({ id: book.id });
  assert.deepEqual(store.listNotebooks().map((b) => b.id), [other.id]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM notes').get().n, 2);
  assert.deepEqual(titles(store.searchNotes({ query: '抛物线' })), []);
  store.close();
});

test('bad input is refused with a reason', () => {
  const store = memoryStore();
  assert.throws(() => store.createNotebook({ title: '   ' }), (e) => e.kind === 'invalid');
  assert.throws(() => store.createNotebook({ title: 'x'.repeat(201) }), (e) => e.kind === 'invalid');
  assert.throws(() => store.createNote({ notebookId: 999, title: 'a' }), (e) => e.kind === 'not-found');
  assert.throws(() => store.getNote({ id: '1' }), (e) => e.kind === 'invalid');
  assert.throws(() => store.createMemory({ content: 'x', source: 'bot' }), (e) => e.kind === 'invalid');
  store.close();
});

for (const fts of [true, false]) {
  const label = fts ? 'with the trigram index' : 'without it (LIKE only)';

  test(`Chinese search by one, two and three or more characters, ${label}`, () => {
    const { store } = seeded({ fts });
    assert.equal(store.fts, fts ? 'trigram' : 'none');
    const one = store.searchNotes({ query: '数' });
    assert.equal(one.mode, 'like');
    assert.deepEqual(titles(one), ['Quadratic', '二次函数', '数列']);
    const two = store.searchNotes({ query: '函数' });
    assert.equal(two.mode, 'like', 'trigram cannot match two characters');
    assert.deepEqual(titles(two), ['Quadratic', '二次函数']);
    const three = store.searchNotes({ query: '抛物线' });
    assert.equal(three.mode, fts ? 'fts' : 'like');
    assert.deepEqual(titles(three), ['二次函数']);
    store.close();
  });

  test(`mixed Chinese and English queries, ${label}`, () => {
    const { store, other } = seeded({ fts });
    assert.deepEqual(titles(store.searchNotes({ query: 'QUADRATIC 函数' })), ['Quadratic']);
    const long = store.searchNotes({ query: 'parabola function' });
    assert.equal(long.mode, fts ? 'fts' : 'like');
    assert.deepEqual(titles(long), ['Quadratic']);
    assert.deepEqual(titles(store.searchNotes({ query: '函数', notebookId: other.id })), ['Quadratic']);
    assert.deepEqual(titles(store.searchNotes({ query: '100%' })), ['Percent']);
    assert.deepEqual(titles(store.searchNotes({ query: '_' })), [], 'LIKE wildcards are matched literally');
    assert.deepEqual(store.searchNotes({ query: '   ' }), { mode: 'none', results: [] });
    store.close();
  });
}

test('search sees notes as they are after edits and deletes', () => {
  const { store } = seeded();
  const [hit] = store.searchNotes({ query: '抛物线' }).results;
  store.updateNote({ id: hit.id, body: '图像是直线' });
  assert.deepEqual(titles(store.searchNotes({ query: '抛物线' })), []);
  assert.deepEqual(titles(store.searchNotes({ query: '是直线' })), ['二次函数']);
  store.deleteNote({ id: hit.id });
  assert.deepEqual(titles(store.searchNotes({ query: '是直线' })), []);
  store.close();
});

test('memories: create, edit, delete one, clear all — clearing leaves notes alone', () => {
  const { store } = seeded();
  const a = store.createMemory({ content: '偏好用例题理解概念' });
  const b = store.createMemory({ content: 'Weak at trigonometry', source: 'agent' });
  assert.deepEqual(store.listMemories().map((m) => m.id), [b.id, a.id]);
  assert.equal(store.updateMemory({ id: a.id, content: '喜欢先看例题' }).content, '喜欢先看例题');
  store.deleteMemory({ id: b.id });
  assert.throws(() => store.getMemory({ id: b.id }), (e) => e.kind === 'not-found');
  store.createMemory({ content: '第三条' });
  assert.deepEqual(store.clearMemories(), { deleted: 2 });
  assert.deepEqual(store.listMemories(), []);
  assert.equal(store.listNotebooks().length, 2);
  assert.equal(store.db.prepare('SELECT count(*) n FROM notes').get().n, 4);
  store.close();
});

test('a transaction that fails keeps nothing of what it did', () => {
  const store = memoryStore();
  const book = store.createNotebook({ title: '本' });
  assert.throws(() => store.transaction(() => {
    store.createNote({ notebookId: book.id, title: '一半' });
    store.createMemory({ content: '一半' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(store.listNotes({ notebookId: book.id }).length, 0);
  assert.equal(store.listMemories().length, 0);
  assert.equal(store.db.isTransaction, false);
  store.close();
});

test('the library lives where recovery never takes it for a setting', async () => {
  const root = tmp();
  const home = path.join(root, '.dsh');
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\n');
  const file = libraryFile(home);
  assert.equal(path.relative(home, file), path.join('learning', 'learning.db'));
  const store = new LearningStore(file);
  const book = store.createNotebook({ title: '本' });
  store.createNote({ notebookId: book.id, title: '笔记', body: '内容' });
  store.createMemory({ content: '记忆' });
  assert.ok(fs.readdirSync(path.dirname(file)).length >= 1);
  const settings = await settingsFiles(home);
  assert.deepEqual(settings, ['.credentials.yaml']);
  assert.ok(settings.every((f) => !f.includes('learning')));
  store.close();
});

test('helpers: query words and excerpts', () => {
  assert.deepEqual(queryTerms('  二次  函数\tgraph '), ['二次', '函数', 'graph']);
  assert.equal(queryTerms('a b c d e f g h i j').length, 8);
  assert.equal(excerpt('短文', ['短']), '短文');
  const long = `${'前'.repeat(100)}目标${'后'.repeat(100)}`;
  const piece = excerpt(long, ['目标'], 40);
  assert.ok(piece.startsWith('…') && piece.endsWith('…') && piece.includes('目标'));
  assert.throws(() => libraryFile(''), (e) => e.kind === 'unavailable');
});

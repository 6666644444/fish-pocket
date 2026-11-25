// The learning library on the real NodeMobile (scripts/test-learning-sim.sh), in the
// filesystem view the app runs: node:sqlite opens a file under /home/dsh, the trigram
// tokenizer exists, and the plugin's store answers Chinese searches both ways (FTS for three
// characters or more, LIKE below that). What engine/test/learning-*.test.mjs cannot show on
// a desktop Node. Exits non-zero when any check fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LearningStore, libraryFile } from './plugins/learning/store.mjs';

const H = '/home/dsh';
let failed = 0;
async function check(name, body) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error?.stack ?? error).split('\n').join('\n      ')}`);
  }
}

console.log(`node ${process.version}, sqlite ${new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v}`);

await check('trigram tokenizer and a three-character Chinese match', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("create virtual table t using fts5(x, tokenize='trigram')");
  db.prepare('insert into t values (?)').run('二次函数的图像是抛物线');
  assert.equal(db.prepare('select count(*) n from t where t match ?').get('函数的').n, 1);
  assert.equal(db.prepare('select count(*) n from t where t match ?').get('函数').n, 0, 'trigram needs three characters');
  db.close();
});

await check('the learning store in the filesystem view', () => {
  const home = `${H}/.dsh`;
  const file = libraryFile(home);
  fs.rmSync(`${home}/learning`, { recursive: true, force: true });
  const store = new LearningStore(file);
  assert.equal(store.fts, 'trigram');
  const book = store.createNotebook({ title: '高中数学' });
  store.createNote({ notebookId: book.id, title: '二次函数', body: '二次函数的图像是一条抛物线。' });
  const long = store.searchNotes({ query: '抛物线' });
  assert.equal(long.mode, 'fts');
  assert.equal(long.results.length, 1);
  const short = store.searchNotes({ query: '函数' });
  assert.equal(short.mode, 'like');
  assert.equal(short.results.length, 1);
  store.createMemory({ content: '喜欢先看例题' });
  assert.deepEqual(store.clearMemories(), { deleted: 1 });
  assert.equal(store.listNotebooks()[0].noteCount, 1, 'clearing memory leaves notes');
  store.close();
  const again = new LearningStore(file);
  assert.equal(again.searchNotes({ query: '抛物线' }).results.length, 1, 'kept on disk (WAL)');
  again.close();
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

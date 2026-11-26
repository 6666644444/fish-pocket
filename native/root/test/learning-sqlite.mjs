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

await check('the knowledge base (M3): chunks, trigram search, float32 vectors', () => {
  const home = `${H}/.dsh`;
  const store = new LearningStore(libraryFile(home));
  assert.equal(store.kbFts, 'trigram');
  const doc = store.importDocument({ title: '微积分', kind: 'md', text: `# 导数\n\n${'导数是函数的瞬时变化率。'.repeat(80)}` });
  assert.ok(doc.chunkCount >= 2);
  assert.equal(store.searchKnowledge({ query: '瞬时变化率' }).mode, 'fts');
  const [first] = store.pendingVectors({ model: 'sim', limit: 1 });
  store.putVectors({ model: 'sim', items: [{ chunkId: first.chunkId, vector: [0.25, -1, 3.5] }] });
  const hit = store.searchKnowledge({ query: '导数', vector: [0.25, -1, 3.5], model: 'sim' });
  assert.equal(hit.mode, 'hybrid');
  assert.equal(hit.results[0].chunkId, first.chunkId);
  store.deleteDocument({ id: doc.id });
  store.close();
});

// Not a check, a finding: whether research can read GBK pages here (engine/plugins/learning/
// webtext.mjs). A small-ICU Node has no GBK decoder; then those pages stay unread.
{
  let gbk = 'no';
  try { new TextDecoder('gb18030'); gbk = 'yes'; } catch { /* small ICU */ }
  console.log(`GBK decoder on NodeMobile: ${gbk}`);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import {
  CHUNKING, RRF_K, blobToVector, chunkText, citationOf, cosine, fuseRanks, sentences, vectorToBlob,
} from '../plugins/learning/kb.mjs';
import { APPLICATION_ID, LearningStore, MIGRATIONS, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

const len = (text) => [...text].length;
const library = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-kb-')), 'learning', 'learning.db');

/** What every chunking must hold: exact slices, the size cap, forward progress, full coverage. */
function checkChunks(text, chunks, { max = CHUNKING.max } = {}) {
  assert.ok(chunks.length > 0);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.ordinal, i);
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text, `chunk ${i} is the slice it claims`);
    assert.ok(len(chunk.text) <= max, `chunk ${i} is ${len(chunk.text)} long`);
    if (i > 0) {
      assert.ok(chunk.start > chunks[i - 1].start, 'each chunk starts later than the one before');
      assert.ok(chunk.start <= chunks[i - 1].end, 'no gap between chunks');
    }
  });
  assert.equal(text.slice(0, chunks[0].start).trim(), '');
  assert.equal(text.slice(chunks[chunks.length - 1].end).trim(), '');
}

// Chunking

test('Chinese is cut at 。！？；, with whole sentences of overlap', () => {
  const text = '函数是一种对应关系。对于集合 A 中的每一个元素，集合 B 中都有唯一的元素与之对应！这叫做映射？'.repeat(20);
  const chunks = chunkText(text);
  checkChunks(text, chunks);
  assert.ok(chunks.length >= 2);
  for (let i = 1; i < chunks.length; i += 1) {
    const overlap = chunks[i - 1].end - chunks[i].start;
    assert.ok(overlap > 0 && len(text.slice(chunks[i].start, chunks[i - 1].end)) <= CHUNKING.overlap, `overlap ${overlap}`);
  }
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk.text, /[。！？]$/u, 'chunks end at a sentence end');
});

test('English is cut at . ! ? ; followed by a space, not inside numbers or abbreviations without a space', () => {
  const text = 'Version 3.14 is out. A function maps each input to exactly one output! Is that clear? '.repeat(25);
  const chunks = chunkText(text);
  checkChunks(text, chunks);
  assert.ok(chunks.every((c) => !/3\.$/.test(c.text.trimEnd())), 'never cut inside 3.14');
  assert.deepEqual(sentences('Pi is 3.14 today. Yes!').map((s) => s.text.trim()), ['Pi is 3.14 today.', 'Yes!']);
});

test('a closing quote stays with its sentence; line breaks end sentences', () => {
  assert.deepEqual(sentences('他说：“好。”然后走了。\n第二行').map((s) => s.text.trim()), ['他说：“好。”', '然后走了。', '第二行']);
});

test('Markdown: a heading starts a chunk and each chunk carries its heading path', () => {
  const text = `# 第一章\n\n${'导数描述变化率。'.repeat(70)}\n\n## 1.1 极限\n\n${'极限可以从左右两侧定义。'.repeat(10)}\n\n# 第二章\n\n积分是导数的逆运算。`;
  const chunks = chunkText(text, { markdown: true });
  checkChunks(text, chunks);
  assert.equal(chunks[0].heading, '第一章');
  const limit = chunks.find((c) => c.text.startsWith('## 1.1'));
  assert.ok(limit, 'the 1.1 heading starts a chunk');
  assert.equal(limit.heading, '第一章 › 1.1 极限');
  const last = chunks[chunks.length - 1];
  assert.ok(last.text.startsWith('# 第二章'));
  assert.equal(last.heading, '第二章', 'a short last section is not merged into the one before');
  assert.equal(chunkText(text)[0].heading, '', 'plain text has no headings');
});

test('boundaries: empty, one short sentence, no punctuation at all, one huge sentence, CRLF-free offsets', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  \n\n '), []);
  const one = chunkText('只有一句');
  assert.equal(one.length, 1);
  assert.equal(one[0].text, '只有一句');
  const flat = 'x'.repeat(2_000);
  const flatChunks = chunkText(flat);
  checkChunks(flat, flatChunks);
  assert.deepEqual(flatChunks.map((c) => len(c.text)), [800, 800, 400]);
  const words = 'word '.repeat(400);
  const wordChunks = chunkText(words);
  checkChunks(words, wordChunks);
  assert.ok(wordChunks.slice(0, -1).every((c) => c.text.endsWith(' ')), 'a long run is cut at a space when there is one');
  const emoji = '🙂'.repeat(900);
  checkChunks(emoji, chunkText(emoji));
  assert.ok(chunkText(emoji).every((c) => !/[\uD800-\uDBFF]$/.test(c.text)), 'never cuts a surrogate pair');
});

test('a tiny tail is folded into the chunk before it', () => {
  const text = `${'这是一句话。'.repeat(83)}尾巴。`;
  const chunks = chunkText(text);
  checkChunks(text, chunks);
  assert.ok(chunks[chunks.length - 1].text.endsWith('尾巴。'));
  assert.ok(len(chunks[chunks.length - 1].text) >= CHUNKING.min);
});

// Vectors and ranking

test('cosine similarity', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 2, 3], [-1, -2, -3]) + 1) < 1e-12);
  assert.ok(Math.abs(cosine([3, 4], [6, 8]) - 1) < 1e-12, 'length does not matter');
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.throws(() => cosine([1], [1, 2]), RangeError);
});

test('vectors round-trip through their BLOB as float32', () => {
  const blob = vectorToBlob([0.5, -1, 3.25]);
  assert.equal(blob.byteLength, 12);
  assert.deepEqual([...blobToVector(blob)], [0.5, -1, 3.25]);
  assert.throws(() => vectorToBlob([1, Number.NaN]), RangeError);
  assert.throws(() => blobToVector(new Uint8Array(5)), RangeError);
});

test('reciprocal rank fusion: agreement beats a single first place', () => {
  const fused = fuseRanks([['a', 'b', 'c'], ['b', 'c', 'd']]);
  assert.deepEqual(fused.map((f) => f.id), ['b', 'c', 'a', 'd']);
  assert.ok(Math.abs(fused[0].score - (1 / (RRF_K + 2) + 1 / (RRF_K + 1))) < 1e-12);
  assert.deepEqual(fuseRanks([[], []]), []);
});

test('the citation names the document, the chunk position and quotes the text', () => {
  const cite = citationOf({
    documentId: 3, documentTitle: '高等数学', chunkId: 9, ordinal: 4, chunkCount: 12, start: 10, end: 20,
    heading: '第一章 › 极限', text: `  极限\n是 ${'很长的'.repeat(100)}`,
  });
  assert.equal(cite.label, '《高等数学》第 5/12 段（第一章 › 极限）');
  assert.equal(len(cite.excerpt), 160);
  assert.ok(cite.excerpt.startsWith('极限 是'));
  assert.ok(cite.excerpt.endsWith('…'));
  assert.deepEqual({ d: cite.documentId, c: cite.chunkId, s: cite.start, e: cite.end }, { d: 3, c: 9, s: 10, e: 20 });
  assert.equal(citationOf({ documentTitle: 'a', ordinal: 0, chunkCount: 1, text: 'x', heading: '' }).label, '《a》第 1/1 段');
});

// The library

function seeded(options) {
  const store = new LearningStore(':memory:', options);
  const calculus = store.importDocument({
    title: '微积分', kind: 'md', sourceName: 'calculus.md',
    text: `# 极限\n\n${'极限描述函数在某点附近的趋势。'.repeat(40)}\n\n# 导数\n\n${'导数是函数的瞬时变化率，等于切线的斜率。'.repeat(30)}`,
  });
  const history = store.importDocument({ title: 'History', kind: 'txt', text: 'The Tang dynasty ruled China from 618 to 907. '.repeat(30) });
  return { store, calculus, history };
}

test('import stores the chunks; get, list and delete (which removes chunks and vectors)', () => {
  const { store, calculus, history } = seeded();
  assert.equal(calculus.kind, 'md');
  assert.equal(calculus.sourceName, 'calculus.md');
  assert.ok(calculus.chunkCount >= 3);
  assert.equal(store.db.prepare('SELECT count(*) n FROM kb_chunks WHERE document_id = ?').get(calculus.id).n, calculus.chunkCount);
  assert.deepEqual(store.listDocuments().map((d) => d.id).sort(), [calculus.id, history.id].sort());
  const [first] = store.pendingVectors({ model: 'm', limit: 1 });
  store.putVectors({ model: 'm', items: [{ chunkId: first.chunkId, vector: [1, 0] }] });
  store.deleteDocument({ id: calculus.id });
  assert.throws(() => store.getDocument({ id: calculus.id }), { kind: 'not-found' });
  assert.equal(store.db.prepare('SELECT count(*) n FROM kb_chunks WHERE document_id = ?').get(calculus.id).n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM kb_vectors').get().n, 0);
  assert.throws(() => store.deleteDocument({ id: calculus.id }), { kind: 'not-found' });
  store.close();
});

test('import refuses bad input; a PDF without text is unsupported (scans), CRLF is normalised', () => {
  const store = new LearningStore(':memory:');
  assert.throws(() => store.importDocument({ title: '', kind: 'txt', text: 'x' }), { kind: 'invalid' });
  assert.throws(() => store.importDocument({ title: 'a', kind: 'docx', text: 'x' }), { kind: 'invalid' });
  assert.throws(() => store.importDocument({ title: 'a', kind: 'txt', text: '  ' }), { kind: 'invalid' });
  assert.throws(() => store.importDocument({ title: 'scan', kind: 'pdf', text: '\n\n' }), { kind: 'unsupported' });
  assert.throws(() => store.importDocument({ title: 'a', kind: 'txt', text: 'x'.repeat(5_000_001) }), { kind: 'invalid' });
  const doc = store.importDocument({ title: 'crlf', kind: 'txt', text: '第一行。\r\n第二行。\r\n' });
  const chunk = store.getChunk({ id: store.pendingVectors({ model: 'm' })[0].chunkId });
  assert.doesNotMatch(chunk.text, /\r/);
  assert.equal(doc.chunkCount, 1);
  assert.equal(store.listDocuments().length, 1, 'nothing half-written by the refusals');
  store.close();
});

test('keyword search: trigram FTS for 3+ character words, LIKE for shorter ones, citations attached', () => {
  const { store, calculus } = seeded();
  assert.equal(store.kbFts, 'trigram');
  const fts = store.searchKnowledge({ query: '瞬时变化率' });
  assert.equal(fts.mode, 'fts');
  assert.ok(fts.results.length > 0);
  for (const hit of fts.results) {
    assert.equal(hit.documentId, calculus.id);
    assert.equal(hit.documentTitle, '微积分');
    assert.match(hit.label, /^《微积分》第 \d+\/\d+ 段（导数）$/);
    assert.match(hit.excerpt, /瞬时变化率/);
  }
  const like = store.searchKnowledge({ query: '导数' });
  assert.equal(like.mode, 'like');
  assert.ok(like.results.length > 0);
  assert.equal(store.searchKnowledge({ query: 'Tang 618' }).results[0].documentTitle, 'History');
  assert.deepEqual(store.searchKnowledge({ query: '   ' }), { mode: 'none', results: [] });
  assert.equal(store.searchKnowledge({ query: '量子力学' }).results.length, 0);
  assert.equal(store.searchKnowledge({ query: '极限', documentIds: [] }).results.length, 0);
  assert.equal(store.searchKnowledge({ query: 'Tang', documentIds: [calculus.id] }).results.length, 0);
  store.close();
});

test('without trigram, every keyword search scans with LIKE', () => {
  const { store } = seeded({ fts: false });
  assert.equal(store.kbFts, 'none');
  const found = store.searchKnowledge({ query: '瞬时变化率' });
  assert.equal(found.mode, 'like');
  assert.ok(found.results.length > 0);
  store.close();
});

test('vectors: pending until stored, one length per model, chunks deleted meanwhile are skipped', () => {
  const { store } = seeded();
  const total = store.vectorStatus().chunks;
  const pending = store.pendingVectors({ model: 'nl-zh', limit: 500 });
  assert.equal(pending.length, Math.min(total, 256));
  assert.deepEqual(store.putVectors({ model: 'nl-zh', items: [{ chunkId: pending[0].chunkId, vector: [1, 2, 3] }] }), { stored: 1, dims: 3 });
  assert.ok(!store.pendingVectors({ model: 'nl-zh', limit: 500 }).some((p) => p.chunkId === pending[0].chunkId));
  assert.equal(store.pendingVectors({ model: 'other', limit: 500 }).length, Math.min(total, 256), 'per model');
  assert.throws(() => store.putVectors({ model: 'nl-zh', items: [{ chunkId: pending[1].chunkId, vector: [1, 2] }] }), { kind: 'invalid' });
  assert.throws(() => store.putVectors({ model: 'nl-zh', items: [{ chunkId: pending[1].chunkId, vector: [1, 'x', 3] }] }), { kind: 'invalid' });
  assert.throws(() => store.putVectors({ model: '', items: [] }), { kind: 'invalid' });
  assert.deepEqual(store.putVectors({ model: 'nl-zh', items: [{ chunkId: 999_999, vector: [1, 2, 3] }] }), { stored: 0, dims: 3 });
  assert.deepEqual(store.vectorStatus().models, [{ model: 'nl-zh', dims: 3, chunks: 1 }]);
  assert.deepEqual(store.clearVectors({ model: 'nl-zh' }), { deleted: 1 });
  store.close();
});

test('hybrid search: a chunk found by meaning and by keyword ranks first; meaning alone still finds', () => {
  const store = new LearningStore(':memory:');
  const doc = store.importDocument({
    title: '笔记', kind: 'txt',
    text: ['苹果是一种水果，富含维生素。', '香蕉是黄色的水果。', '汽车需要汽油才能行驶。'].map((s) => s.repeat(40)).join('\n'),
  });
  const chunks = store.db.prepare('SELECT id, text FROM kb_chunks WHERE document_id = ? ORDER BY ordinal').all(doc.id);
  // Fake vectors: axis 0 = fruit, axis 1 = vehicle.
  store.putVectors({
    model: 'fake',
    items: chunks.map((c) => ({ chunkId: c.id, vector: c.text.includes('汽车') ? [0, 1] : c.text.includes('香蕉') ? [0.9, 0.1] : [1, 0] })),
  });
  const result = store.searchKnowledge({ query: '维生素', vector: [1, 0], model: 'fake', limit: 50 });
  assert.equal(result.mode, 'hybrid');
  assert.match(result.results[0].excerpt, /苹果/);
  assert.ok(result.results.some((r) => r.excerpt.includes('香蕉')), 'found by meaning without the keyword');
  assert.ok(!result.results.some((r) => r.excerpt.startsWith('汽车')), 'orthogonal chunks score 0 and are left out');
  const scores = result.results.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.throws(() => store.searchKnowledge({ query: 'x', vector: [1, 0, 0], model: 'fake' }), { kind: 'invalid' });
  assert.equal(store.searchKnowledge({ query: '维生素', vector: [1, 0], model: 'unknown' }).results.length > 0, true,
    'a model with no vectors falls back to the keyword ranking');
  store.close();
});

test('a schema 3 library opens at schema 4 with its data intact', () => {
  const file = library();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 3)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 3`);
  db.prepare("INSERT INTO session_modes(session_id, mode, updated_at) VALUES ('s1', 'quiz', 1)").run();
  db.close();
  const store = new LearningStore(file);
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(store.version, 4);
  assert.equal(store.getSessionMode({ sessionId: 's1' }).mode, 'quiz');
  assert.deepEqual(store.listDocuments(), []);
  store.close();
});

test('routes: import and search over HTTP; scanned PDFs answer 422 unsupported', async () => {
  const routes = new Map();
  const ctx = {
    effect: (run) => run(),
    on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
  };
  new Learning(ctx, { file: library() });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  const imported = await post('kb.documents.import', { title: '讲义', kind: 'txt', text: '傅里叶变换把信号分解成频率。'.repeat(50) });
  assert.equal(imported.status, 200);
  const found = await post('kb.search', { query: '傅里叶变换' });
  assert.equal(found.body.result.results[0].documentId, imported.body.result.id);
  assert.equal((await post('kb.documents.import', { title: 'scan', kind: 'pdf', text: '' })).status, 422);
  const cloud = await post('kb.parse.cloud', { name: 'scan.pdf', data: '' });
  assert.equal(cloud.status, 422);
  assert.equal(cloud.body.error.kind, 'unsupported');
  assert.equal((await post('kb.status')).body.result.search, 'trigram');
});

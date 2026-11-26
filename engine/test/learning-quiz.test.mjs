import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import {
  MASTERY, SHORT_GRADING, choiceIndex, grade, keyTerms, nextMistake, normalizeAnswer, normalizeQuestion,
} from '../plugins/learning/quiz.mjs';
import { TOOL } from '../plugins/learning/quiz-tool.mjs';
import { APPLICATION_ID, LearningStore, MIGRATIONS, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

const choice = { kind: 'choice', prompt: '2 + 2 = ?', options: ['3', '4', '5', '22'], answer: 'B', explanation: '2 加 2 等于 4', topic: '算术' };
const short = { kind: 'short', prompt: '导数的几何意义是什么？', answer: '函数图像在该点切线的斜率', topic: '微积分' };

// Validation

test('a choice question: letters stripped from options, answer stored as a letter', () => {
  const q = normalizeQuestion({ ...choice, options: ['A. 3', 'B) 4', 'C、5', '22'], answer: 1 });
  assert.deepEqual(q.options, ['3', '4', '5', '22']);
  assert.equal(q.answer, 'B');
  assert.equal(normalizeQuestion({ ...choice, answer: '(b)' }).answer, 'B');
});

test('bad questions are refused with a reason', () => {
  for (const [bad, why] of [
    [{ ...choice, kind: 'essay' }, /kind/],
    [{ ...choice, prompt: ' ' }, /prompt/],
    [{ ...choice, options: ['only'] }, /2 to 6/],
    [{ ...choice, options: ['1', '2', '3', '4', '5', '6', '7'] }, /2 to 6/],
    [{ ...choice, options: ['4', '4'] }, /different/],
    [{ ...choice, answer: 'E' }, /letter/],
    [{ ...choice, answer: 'A or B' }, /letter/],
    [{ ...short, answer: '' }, /answer/],
    [{ ...short, options: ['x'] }, /no options/],
    [null, /object/],
  ]) {
    assert.throws(() => normalizeQuestion(bad), why);
  }
  assert.deepEqual(normalizeQuestion({ ...short, options: [] }).options, []);
});

test('choiceIndex reads one option letter in common shapes', () => {
  assert.equal(choiceIndex('B', 4), 1);
  assert.equal(choiceIndex('b.', 4), 1);
  assert.equal(choiceIndex('我选 C', 4), 2);
  assert.equal(choiceIndex('(d)', 4), 3);
  assert.equal(choiceIndex(0, 4), 0);
  assert.equal(choiceIndex('E', 4), null);
  assert.equal(choiceIndex('A 或 B', 4), null);
  assert.equal(choiceIndex('BAD', 4), null, 'letters inside a word are not choices');
  assert.equal(choiceIndex('', 4), null);
});

// Grading

test('choice grading', () => {
  const q = normalizeQuestion(choice);
  assert.deepEqual(grade(q, 'B'), { verdict: 'correct', score: 1, gradedBy: 'rule', chosen: 'B' });
  assert.deepEqual(grade(q, 'a'), { verdict: 'incorrect', score: 0, gradedBy: 'rule', chosen: 'A' });
  assert.throws(() => grade(q, '4'), /option letter/);
  assert.throws(() => grade(q, 'C', { judged: 'correct' }) && grade(q, 'Z'), /option letter/);
  assert.equal(grade(q, 'C', { judged: 'correct' }).verdict, 'incorrect', 'a model verdict never overrides a choice');
});

test('short grading: normalised match, term overlap thresholds, the model verdict decides when given', () => {
  const q = normalizeQuestion(short);
  assert.equal(grade(q, '函数图像在该点切线的斜率。').verdict, 'correct');
  assert.equal(grade(q, '  函数图像，在该点 切线的斜率 ').verdict, 'correct', 'punctuation and spaces do not count');
  assert.equal(grade(q, '切线的斜率').verdict, 'partial');
  assert.equal(grade(q, '面积').verdict, 'incorrect');
  const english = normalizeQuestion({ kind: 'short', prompt: 'p', answer: 'The slope of the tangent line' });
  assert.equal(grade(english, 'slope of the tangent line').verdict, 'correct');
  assert.equal(grade(english, 'tangent').verdict, 'partial', 'one of three key terms');
  assert.equal(grade(english, 'banana').verdict, 'incorrect');
  assert.equal(grade(english, 'the TANGENT line slope').verdict, 'correct');
  assert.deepEqual(grade(q, '描述变化快慢的切线倾斜程度', { judged: 'correct' }), { verdict: 'correct', score: 1, gradedBy: 'model' });
  assert.equal(grade(q, 'x', { judged: 'partial' }).score, 0.5);
  assert.throws(() => grade(q, 'x', { judged: 'maybe' }), /judged/);
  assert.throws(() => grade(q, '  '), /empty/);
  assert.ok(SHORT_GRADING.correct > SHORT_GRADING.partial);
});

test('numbers count as key terms; normalisation is NFKC', () => {
  assert.ok(keyTerms('答案是 3.14').has('3.14'));
  assert.ok(keyTerms('x = 7').has('7'));
  assert.equal(normalizeAnswer('ＡＢＣ　１２３'), 'abc123');
  const q = normalizeQuestion({ kind: 'short', prompt: 'π 约等于？', answer: '3.14' });
  assert.equal(grade(q, '３．１４').verdict, 'correct');
  assert.equal(grade(q, '3.15').verdict, 'incorrect');
});

// The mistake-book rule

test('wrong answers go in, a wrong answer resets the streak, MASTERY right in a row take it out', () => {
  assert.equal(MASTERY, 2);
  assert.deepEqual(nextMistake(null, 'correct'), { action: 'none', streak: 0 });
  assert.deepEqual(nextMistake(null, 'incorrect'), { action: 'add', streak: 0 });
  assert.deepEqual(nextMistake(null, 'partial'), { action: 'add', streak: 0 }, 'partly right is not right');
  assert.deepEqual(nextMistake({ streak: 0 }, 'correct'), { action: 'progress', streak: 1 });
  assert.deepEqual(nextMistake({ streak: 1 }, 'correct'), { action: 'remove', streak: 2 });
  assert.deepEqual(nextMistake({ streak: 1 }, 'incorrect'), { action: 'reset', streak: 0 });
  assert.deepEqual(nextMistake({ streak: 2 }, 'correct', 4), { action: 'progress', streak: 3 });
});

// The library

test('save, answer, the mistake book in and out, attempts and topics', () => {
  let now = 100;
  const store = new LearningStore(':memory:', { now: () => now });
  const [c, s] = store.saveQuestions({ questions: [choice, short], sessionId: 'sess-1' });
  assert.equal(c.answer, 'B');
  assert.equal(c.sessionId, 'sess-1');
  assert.equal(s.kind, 'short');
  assert.equal(store.listQuestions()[0].answer, undefined, 'lists leave the answer out by default');

  now += 1;
  const wrong = store.answerQuestion({ id: c.id, answer: 'C' });
  assert.deepEqual({ v: wrong.verdict, book: wrong.mistakeBook, streak: wrong.streak }, { v: 'incorrect', book: 'added', streak: 0 });
  assert.equal(wrong.correctAnswer, 'B');
  assert.deepEqual(store.listQuestions({ mistakes: true }).map((q) => q.id), [c.id]);

  now += 1;
  assert.deepEqual(store.answerQuestion({ id: c.id, answer: 'B' }).mistakeBook, 'in');
  now += 1;
  assert.equal(store.answerQuestion({ id: c.id, answer: 'D' }).streak, 0, 'a wrong answer resets the run');
  now += 1;
  store.answerQuestion({ id: c.id, answer: 'B' });
  now += 1;
  const out = store.answerQuestion({ id: c.id, answer: 'b' });
  assert.equal(out.mistakeBook, 'removed');
  assert.deepEqual(store.listQuestions({ mistakes: true }), []);
  assert.equal(store.answerQuestion({ id: c.id, answer: 'B' }).mistakeBook, 'not-in');

  assert.equal(store.listAttempts({ questionId: c.id }).length, 6);
  assert.deepEqual(store.listAttempts({ questionId: c.id })[0], { id: 6, answer: 'B', verdict: 'correct', score: 1, gradedBy: 'rule', createdAt: now });
  assert.deepEqual(store.getQuestion({ id: c.id }), { ...store.getQuestion({ id: c.id }), attempts: 6, lastVerdict: 'correct', inMistakes: false });

  store.answerQuestion({ id: s.id, answer: '面积' });
  assert.deepEqual(store.quizTopics(), [{ topic: '微积分', questions: 1, mistakes: 1 }, { topic: '算术', questions: 1, mistakes: 0 }]);
  assert.deepEqual(store.listQuestions({ topic: '微积分' }).map((q) => q.id), [s.id]);
  store.close();
});

test('the learner can overrule a grade; a batch with one bad question saves nothing', () => {
  const store = new LearningStore(':memory:');
  const [s] = store.saveQuestions({ questions: [short] });
  assert.equal(store.answerQuestion({ id: s.id, answer: '倾斜程度' }).mistakeBook, 'added');
  const overruled = store.answerQuestion({ id: s.id, answer: '倾斜程度', judged: 'correct', gradedBy: 'user' });
  assert.deepEqual({ v: overruled.verdict, by: overruled.gradedBy, book: overruled.mistakeBook }, { v: 'correct', by: 'user', book: 'in' });
  assert.throws(() => store.answerQuestion({ id: s.id, answer: 'x', gradedBy: 'model' }), { kind: 'invalid' });
  assert.throws(() => store.saveQuestions({ questions: [choice, { ...choice, answer: 'Z' }] }), /question 2/);
  assert.equal(store.listQuestions().length, 1);
  assert.throws(() => store.saveQuestions({ questions: [] }), { kind: 'invalid' });
  assert.throws(() => store.answerQuestion({ id: 999, answer: 'A' }), { kind: 'not-found' });
  assert.throws(() => store.answerQuestion({ id: s.id, answer: '' }), { kind: 'invalid' });
  assert.equal(store.listAttempts({ questionId: s.id }).length, 2, 'refused answers are not recorded');
  store.close();
});

test('deleting a question removes its attempts and its mistake-book row', () => {
  const store = new LearningStore(':memory:');
  const [c] = store.saveQuestions({ questions: [choice] });
  store.answerQuestion({ id: c.id, answer: 'A' });
  store.deleteQuestion({ id: c.id });
  assert.equal(store.db.prepare('SELECT count(*) n FROM quiz_attempts').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM quiz_mistakes').get().n, 0);
  assert.throws(() => store.deleteQuestion({ id: c.id }), { kind: 'not-found' });
  store.close();
});

test('a schema 4 library opens at the latest schema with its data intact', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-quiz-')), 'learning.db');
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 4)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 4`);
  db.prepare("INSERT INTO kb_documents(title, kind, chars, chunk_count, created_at, updated_at) VALUES ('kept', 'txt', 1, 0, 1, 1)").run();
  db.close();
  const store = new LearningStore(file);
  assert.ok(SCHEMA_VERSION >= 5);
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.listDocuments()[0].title, 'kept');
  assert.deepEqual(store.listQuestions(), []);
  store.close();
});

// The plugin: routes and the tool

function plugin() {
  const routes = new Map();
  const tools = [];
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: (name, handler) => handlers.set(name, handler),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: (tool, options) => { const entry = { tool, options }; tools.push(entry); return () => tools.splice(tools.indexOf(entry), 1); } },
  };
  new Learning(ctx, { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-quiz-plugin-')), 'l.db'), embedder: null });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  return { tools, post, dispose: () => disposers.reverse().forEach((d) => d()) };
}

const agent = (id) => ({ session: { id, header: {} } });

test('the learning_quiz tool is offered only in learning sessions, saves and grades', async () => {
  const p = plugin();
  assert.deepEqual(p.tools.map((t) => t.tool.name), [TOOL, 'deep_research']);
  const { tool, options } = p.tools[0];
  assert.equal(tool.name, TOOL);
  assert.equal(options.when({ agent: agent('plain') }), false);
  await p.post('sessions.setMode', { sessionId: 'quiz-1', mode: 'quiz' });
  assert.equal(options.when({ agent: agent('quiz-1') }), true);
  assert.equal(options.when({ agent: { session: { id: 'quiz-1', header: { origin: 'subagent' } } } }), false);

  const saved = await tool.execute({ action: 'save', questions: [choice] }, { agent: agent('quiz-1') });
  const id = saved.saved[0].id;
  assert.match(tool.output.render({ action: 'save' }, saved)[0].text, /do not reveal the answer/);
  const graded = await tool.execute({ action: 'grade', questionId: id, answer: '我选 A' }, { agent: agent('quiz-1') });
  assert.equal(graded.verdict, 'incorrect');
  assert.match(tool.output.render({ action: 'grade' }, graded)[0].text, /mistake book/);
  const listed = await tool.execute({ action: 'list', mistakes: true }, {});
  assert.deepEqual(listed.questions.map((q) => q.id), [id]);
  assert.equal('answer' in listed.questions[0], false, 'listing never shows the answer to the model');
  await assert.rejects(tool.execute({ action: 'grade', answer: 'A' }, {}), /questionId/);

  const book = await p.post('quiz.questions.list', { mistakes: true });
  assert.equal(book.body.result[0].sessionId, 'quiz-1');
  const redo = await p.post('quiz.answer', { id, answer: 'B' });
  assert.equal(redo.body.result.mistakeBook, 'in');
  assert.equal((await p.post('quiz.questions.get', { id })).body.result.answer, 'B');
  assert.equal((await p.post('quiz.answer', { id, answer: 'Z' })).status, 400);
  p.dispose();
  assert.equal(p.tools.length, 0, 'the tool goes away with the plugin');
});

// Every case the tool returns must cross DSH's Remote boundary: one undefined field (a short
// answer's `chosen`, the `streak` of a question not in the book) failed the whole call on
// the phone with "value is not lossless JSON" (only a wrong multiple-choice answer passed).
test('every learning_quiz result is lossless JSON', async () => {
  const p = plugin();
  const { tool } = p.tools[0];
  await p.post('sessions.setMode', { sessionId: 'quiz-json', mode: 'quiz' });
  const ctx = { agent: agent('quiz-json') };
  const lossless = (value, what) => assert.ok(isRemoteJsonValue(value), `${what}: ${JSON.stringify(value)}`);
  const saved = await tool.execute({ action: 'save', questions: [choice, short, { kind: 'choice', prompt: '3 + 3 = ?', options: ['6', '7'], answer: 'A' }] }, ctx);
  lossless(saved, 'save');
  const [c, s, c2] = saved.saved.map((q) => q.id);
  lossless(await tool.execute({ action: 'grade', questionId: c2, answer: 'A' }, ctx), 'choice right, never in the book');
  lossless(await tool.execute({ action: 'grade', questionId: c, answer: 'A' }, ctx), 'choice wrong, into the book');
  lossless(await tool.execute({ action: 'grade', questionId: c, answer: 'B' }, ctx), 'choice right, still in the book');
  const out = await tool.execute({ action: 'grade', questionId: c, answer: 'B' }, ctx);
  assert.equal(out.mistakeBook, 'removed');
  assert.equal('streak' in out, false);
  lossless(out, 'choice right, out of the book');
  const shortRule = await tool.execute({ action: 'grade', questionId: s, answer: '切线的斜率' }, ctx);
  assert.equal('chosen' in shortRule, false);
  lossless(shortRule, 'short, graded by rule');
  lossless(await tool.execute({ action: 'grade', questionId: s, answer: '斜率', judged: 'correct' }, ctx), 'short, judged by the model');
  lossless(await tool.execute({ action: 'list' }, ctx), 'list');
  lossless(await tool.execute({ action: 'list', mistakes: true }, ctx), 'list the book');
  p.dispose();
});

test('the quiz skill tells the model to use the tool', () => {
  const text = fs.readFileSync(new URL('../skills/learning-quiz/SKILL.md', import.meta.url), 'utf8');
  assert.match(text, /learning_quiz/);
  assert.doesNotMatch(text, /not saved to a question bank/);
});

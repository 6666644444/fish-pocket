import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isSkillName } from '@deepseek-ai/dsh-skill';
import { parse as parseYaml } from 'yaml';
import Learning, { ROUTE, turnNote } from '../plugins/learning/index.mjs';
import {
  BUNDLED_SKILLS, MEMORY_BUDGET, MODES, MODE_IDS, SOURCE, cut, modeInstructions, noteSections, pickMemories,
  relevanceTokens, userTextOf,
} from '../plugins/learning/modes.mjs';
import { APPLICATION_ID, LearningStore, MIGRATIONS, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const library = () => path.join(temp('dsh-learning-modes-'), 'learning', 'learning.db');
const len = (text) => [...text].length;
const memory = (id, content, updatedAt = id) => ({ id, content, updatedAt });

function fakeContext(config) {
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); },
    on: (name, handler) => { handlers.set(name, handler); },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  new Learning(ctx, config);
  return { routes, preStep: handlers.get('agent/pre-step'), dispose: () => disposers.reverse().forEach((d) => d()) };
}

async function post(routes, method, body) {
  const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, {
    method: 'POST', body: JSON.stringify(body ?? {}),
  }));
  return { status: response.status, body: await response.json() };
}

const userMessage = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

/** One pre-step pass for `sessionId`. */
const step = (preStep, sessionId, { number = 1, messages = [userMessage('hello')], kind = 'proceed', aborted = false } = {}) =>
  preStep({ agent: { session: { id: sessionId } }, step: number, signal: { aborted } }, async () => ({ kind, messages }));

// The bundled mode skills

test('each mode ships as a bundled skill DSH can load: valid frontmatter, a name matching its folder', () => {
  assert.deepEqual(MODE_IDS, ['qa', 'socratic', 'quiz']);
  for (const mode of MODE_IDS) {
    const text = fs.readFileSync(path.join(BUNDLED_SKILLS, MODES[mode].skill, 'SKILL.md'), 'utf8');
    const [, head] = text.split(/^---\r?$/m);
    const meta = parseYaml(head);
    assert.equal(meta.name, MODES[mode].skill);
    assert.ok(isSkillName(meta.name));
    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.length > 40);
    // dsh-tool-skill caps catalog descriptions at 500 characters.
    assert.ok(meta.description.length <= 500);
    assert.ok(modeInstructions(mode).length > 200);
    assert.doesNotMatch(modeInstructions(mode), /^---/);
  }
  assert.match(modeInstructions('socratic'), /Never state the final answer/);
  assert.match(modeInstructions('socratic'), /one question per message/);
  assert.match(modeInstructions('quiz'), /one question at a time/i);
  assert.throws(() => modeInstructions('lecture'), /unknown learning mode/);
});

// Picking memories

test('relevance tokens: English words, Chinese character pairs, lower-cased', () => {
  assert.deepEqual([...relevanceTokens('Learn Python 3 a b')].sort(), ['learn', 'python'].sort());
  assert.deepEqual([...relevanceTokens('高等数学')].sort(), ['等数', '数学', '高等'].sort());
  assert.deepEqual([...relevanceTokens('用Python学微积分')].sort(), ['python', '学微', '微积', '积分'].sort());
  assert.equal(relevanceTokens('，。!?').size, 0);
});

test('memories that share words with the turn come first, then one recent one fills in', () => {
  const memories = [
    memory(1, '我在准备考研数学，目标 130 分', 10),
    memory(2, 'Prefers short answers with one example', 20),
    memory(3, '对极限和导数的定义还不熟', 5),
    memory(4, '喜欢用 Python 做练习', 30),
  ];
  const picked = pickMemories(memories, '这道求极限的题怎么做？导数也不太懂');
  assert.deepEqual(picked.map((m) => m.id), [3, 4]);
  assert.equal(pickMemories([], 'anything').length, 0);
  // No word in common: only the most recent one.
  assert.deepEqual(pickMemories(memories, 'hello').map((m) => m.id), [4]);
});

test('at most three memories; on a tie the newer one wins', () => {
  const memories = [1, 2, 3, 4, 5].map((id) => memory(id, `python note ${id}`, id));
  assert.deepEqual(pickMemories(memories, 'python').map((m) => m.id), [5, 4, 3]);
  assert.equal(MEMORY_BUDGET.count, 3);
});

test('each memory is cut to 300 characters and all of them to 800, counted in code points', () => {
  const long = '数学'.repeat(400) + '🙂'.repeat(50); // 850 code points
  const memories = [memory(1, `数学 ${long}`, 3), memory(2, `数学 ${long}`, 2), memory(3, `数学 ${long}`, 1)];
  const picked = pickMemories(memories, '数学');
  assert.equal(picked.length, 3);
  for (const m of picked) assert.ok(len(m.text) <= MEMORY_BUDGET.each);
  assert.ok(picked.every((m) => m.cut && m.text.endsWith('…')));
  assert.ok(picked.reduce((sum, m) => sum + len(m.text), 0) <= MEMORY_BUDGET.total);
  assert.equal(len(picked[2].text), MEMORY_BUDGET.total - 2 * MEMORY_BUDGET.each);
  // Too little room left for a useful piece: the memory is left out, not sent as a stub.
  const tight = pickMemories(memories, '数学', { count: 3, each: 300, total: 330, minPiece: 40 });
  assert.equal(tight.length, 1);
  assert.equal(cut('🙂🙂🙂', 2), '🙂…');
  assert.equal(cut('short', 10), 'short');
});

test('whitespace in a memory is folded to single spaces; short ones are sent whole', () => {
  const [picked] = pickMemories([memory(1, '  likes\n\n  maths  ')], 'maths');
  assert.deepEqual(picked, { id: 1, text: 'likes maths', cut: false });
});

test('only what the user wrote counts as the turn text', () => {
  const messages = [
    userMessage('first'),
    { role: 'user', source: { kind: 'voice-call' }, content: [{ type: 'text', text: 'a note' }] },
    { role: 'user', content: [{ type: 'image', data: '' }, { type: 'text', text: 'second' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'reply' }] },
  ];
  assert.equal(userTextOf(messages), 'first\nsecond');
});

test('the note: full instructions when announcing, a reminder otherwise, memories under their own heading', () => {
  const full = noteSections({ mode: 'socratic', announce: true, instructions: 'INSTRUCTIONS', memories: [{ id: 1, text: 'likes maths' }] });
  assert.deepEqual(full.map((s) => s.name), ['learning-mode', 'learning-memory']);
  assert.match(full[0].text, /INSTRUCTIONS/);
  assert.match(full[1].text, /^What you know about this learner/);
  assert.match(full[1].text, /- likes maths/);
  const reminder = noteSections({ mode: 'quiz', announce: false });
  assert.equal(reminder.length, 1);
  assert.match(reminder[0].text, /keep following the learning-quiz instructions/);
});

// The library: schema 3, settings, session modes

test('a schema 2 library opens at the latest schema with its data intact', () => {
  const file = library();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  MIGRATIONS[0](db, {});
  MIGRATIONS[1](db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 2`);
  db.prepare("INSERT INTO memories(content, source, created_at, updated_at) VALUES ('kept', 'user', 1, 1)").run();
  db.close();
  const store = new LearningStore(file);
  assert.ok(SCHEMA_VERSION >= 3);
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.listMemories()[0].content, 'kept');
  assert.equal(store.getSessionMode({ sessionId: 's1' }), null);
  store.close();
});

test('settings: memory injection is on until turned off', () => {
  const store = new LearningStore(':memory:');
  assert.deepEqual(store.getSettings(), { injectMemories: true, appleEmbedding: true, researchWeb: true });
  assert.deepEqual(store.updateSettings({ injectMemories: false }), { injectMemories: false, appleEmbedding: true, researchWeb: true });
  assert.deepEqual(store.updateSettings({ injectMemories: true }), { injectMemories: true, appleEmbedding: true, researchWeb: true });
  assert.deepEqual(store.updateSettings({ appleEmbedding: false }), { injectMemories: true, appleEmbedding: false, researchWeb: true });
  assert.throws(() => store.updateSettings({}), { kind: 'invalid' });
  assert.throws(() => store.updateSettings({ injectMemories: 'no' }), { kind: 'invalid' });
  store.close();
});

test('session modes: set, change (which forgets the announcement), clear, and bad input', () => {
  const store = new LearningStore(':memory:', { now: () => 7 });
  assert.equal(store.setSessionMode({ sessionId: 's1', mode: 'qa' }).mode, 'qa');
  store.markAnnounced({ sessionId: 's1', mode: 'qa' });
  assert.equal(store.getSessionMode({ sessionId: 's1' }).announced, 'qa');
  assert.equal(store.setSessionMode({ sessionId: 's1', mode: 'qa' }).announced, 'qa');
  assert.equal(store.setSessionMode({ sessionId: 's1', mode: 'quiz' }).announced, null);
  assert.equal(store.setSessionMode({ sessionId: 's1', mode: null }), null);
  assert.equal(store.getSessionMode({ sessionId: 's1' }), null);
  assert.throws(() => store.setSessionMode({ sessionId: 's1', mode: 'lecture' }), { kind: 'invalid' });
  assert.throws(() => store.setSessionMode({ sessionId: '', mode: 'qa' }), { kind: 'invalid' });
  assert.throws(() => store.getSessionMode({ sessionId: 'x'.repeat(201) }), { kind: 'invalid' });
  store.close();
});

test('sessions.list: the sessions in a mode, most recently set first', () => {
  let now = 1;
  const store = new LearningStore(':memory:', { now: () => now });
  store.setSessionMode({ sessionId: 'a', mode: 'qa' });
  now = 2;
  store.setSessionMode({ sessionId: 'b', mode: 'quiz' });
  now = 3;
  store.setSessionMode({ sessionId: 'a', mode: 'socratic' });
  assert.deepEqual(store.listSessionModes().map((s) => [s.sessionId, s.mode]), [['a', 'socratic'], ['b', 'quiz']]);
  store.setSessionMode({ sessionId: 'b', mode: null });
  assert.deepEqual(store.listSessionModes().map((s) => s.sessionId), ['a']);
  store.close();
});

test('ending a mode keeps the session on the learning record; it can be hidden or put back in a mode', () => {
  let now = 1;
  const store = new LearningStore(':memory:', { now: () => now });
  store.setSessionMode({ sessionId: 'a', mode: 'socratic' });
  store.setSessionMode({ sessionId: 'b', mode: 'quiz' });
  now = 5;
  store.setSessionMode({ sessionId: 'a', mode: null });
  now = 6;
  store.setSessionMode({ sessionId: 'b', mode: null });
  assert.equal(store.setSessionMode({ sessionId: 'b', mode: null }), null, 'ending twice is harmless');
  assert.deepEqual(store.listSessionModes(), []);
  assert.deepEqual(store.listLearningHistory(), [
    { sessionId: 'b', mode: 'quiz', endedAt: 6, updatedAt: 6 },
    { sessionId: 'a', mode: 'socratic', endedAt: 5, updatedAt: 5 },
  ]);
  assert.deepEqual(store.hideLearningHistory({ sessionId: 'b' }), { hidden: true });
  assert.deepEqual(store.listLearningHistory().map((s) => s.sessionId), ['a']);
  assert.throws(() => store.hideLearningHistory({ sessionId: 'never' }), { kind: 'not-found' });
  now = 7;
  const again = store.setSessionMode({ sessionId: 'a', mode: 'qa' });
  assert.deepEqual([again.mode, again.announced], ['qa', null], 'back in a mode: announced afresh');
  assert.deepEqual(store.listLearningHistory(), []);
  assert.deepEqual(store.listSessionModes().map((s) => s.sessionId), ['a']);
  assert.throws(() => store.hideLearningHistory({ sessionId: 'a' }), { kind: 'not-found' }, 'a session in a mode is not on the record');
  store.setSessionMode({ sessionId: 'b', mode: 'quiz' });
  store.setSessionMode({ sessionId: 'b', mode: null });
  assert.deepEqual(store.listLearningHistory().map((s) => s.sessionId), ['b'], 'hidden is undone by using it again');
  store.close();
});

test('after ending a mode the next turn is told once that learning is over', () => {
  const store = new LearningStore(':memory:');
  store.setSessionMode({ sessionId: 's1', mode: 'socratic' });
  assert.ok(turnNote(store, 's1', []));
  store.setSessionMode({ sessionId: 's1', mode: null });
  const note = turnNote(store, 's1', []);
  assert.match(note.content[0].text, /ended learning mode/);
  assert.match(note.content[0].text, /ordinary conversation/);
  assert.equal(turnNote(store, 's1', []), undefined, 'only once');
  store.setSessionMode({ sessionId: 's1', mode: 'quiz' });
  store.setSessionMode({ sessionId: 's1', mode: 'qa' });
  assert.match(turnNote(store, 's1', []).content[0].text, /no longer applies/, 'a new mode replaces the old one');
  store.close();
});

test('a schema 6 library keeps its learning sessions at schema 7', () => {
  const file = library();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 6)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 6`);
  db.prepare("INSERT INTO session_modes(session_id, mode, announced, updated_at) VALUES ('old', 'quiz', 'quiz', 3)").run();
  db.close();
  const store = new LearningStore(file);
  assert.ok(store.version >= 7);
  assert.deepEqual(store.getSessionMode({ sessionId: 'old' }), { sessionId: 'old', mode: 'quiz', announced: 'quiz', updatedAt: 3 });
  assert.deepEqual(store.listLearningHistory(), []);
  store.close();
});

test('the learning record over the routes', async () => {
  const home = temp('dsh-learning-history-');
  const routes = new Map();
  new Learning({
    effect: (run) => run(),
    on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
  }, { file: path.join(home, 'l.db'), embedder: null });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  await post('sessions.setMode', { sessionId: 'h1', mode: 'qa' });
  await post('sessions.setMode', { sessionId: 'h1', mode: null });
  assert.deepEqual((await post('sessions.history')).body.result.map((s) => [s.sessionId, s.mode]), [['h1', 'qa']]);
  assert.equal((await post('sessions.hide', { sessionId: 'h1' })).status, 200);
  assert.deepEqual((await post('sessions.history')).body.result, []);
  assert.equal((await post('sessions.hide', { sessionId: 'h1' })).status, 404);
});

// A turn

test('a session with no learning mode is left exactly as it was', async () => {
  const plugin = fakeContext({ file: library() });
  const messages = [userMessage('hi')];
  const decision = await step(plugin.preStep, 'plain', { messages });
  assert.deepEqual(decision, { kind: 'proceed', messages });
  plugin.dispose();
});

test('a learning session gets the full instructions once, then reminders, with memories each turn', async () => {
  const plugin = fakeContext({ file: library() });
  await post(plugin.routes, 'memories.create', { content: '对极限的定义还不熟' });
  assert.equal((await post(plugin.routes, 'sessions.setMode', { sessionId: 's1', mode: 'socratic' })).body.result.mode, 'socratic');

  const first = await step(plugin.preStep, 's1', { messages: [userMessage('怎么求这个极限')] });
  assert.equal(first.messages.length, 2);
  const note = first.messages[1];
  assert.equal(note.role, 'user');
  assert.equal(note.source.kind, SOURCE);
  assert.equal(note.source.form, 'snapshot');
  assert.deepEqual(note.source.sections.map((s) => s.name), ['learning-mode', 'learning-memory']);
  assert.match(note.content[0].text, /Never state the final answer/);
  assert.match(note.content[0].text, /对极限的定义还不熟/);

  const second = await step(plugin.preStep, 's1', { messages: [userMessage('极限是 1 吗')] });
  assert.doesNotMatch(second.messages[1].content[0].text, /Never state the final answer/);
  assert.match(second.messages[1].content[0].text, /keep following the learning-socratic instructions/);
  assert.match(second.messages[1].content[0].text, /对极限的定义还不熟/);

  // A new mode is announced in full again.
  await post(plugin.routes, 'sessions.setMode', { sessionId: 's1', mode: 'quiz' });
  const third = await step(plugin.preStep, 's1');
  assert.match(third.messages[1].content[0].text, /quiz master/);
  plugin.dispose();
});

test('turning injection off leaves the memories out but keeps the mode', async () => {
  const plugin = fakeContext({ file: library() });
  await post(plugin.routes, 'memories.create', { content: 'likes maths' });
  await post(plugin.routes, 'sessions.setMode', { sessionId: 's1', mode: 'qa' });
  assert.equal((await post(plugin.routes, 'settings.update', { injectMemories: false })).body.result.injectMemories, false);
  const decision = await step(plugin.preStep, 's1', { messages: [userMessage('maths question')] });
  assert.deepEqual(decision.messages[1].source.sections.map((s) => s.name), ['learning-mode']);
  assert.doesNotMatch(decision.messages[1].content[0].text, /likes maths/);
  plugin.dispose();
});

test('no note on later steps, rejected or aborted steps, or a retry without messages', async () => {
  const plugin = fakeContext({ file: library() });
  await post(plugin.routes, 'sessions.setMode', { sessionId: 's1', mode: 'qa' });
  for (const options of [{ number: 2 }, { kind: 'reject' }, { aborted: true }, { messages: [] }]) {
    const decision = await step(plugin.preStep, 's1', options);
    assert.equal(decision.messages.length, options.messages?.length ?? 1, JSON.stringify(options));
  }
  plugin.dispose();
});

test('a library that cannot be opened never stops the turn', async () => {
  const dir = temp('dsh-learning-modes-bad-');
  const file = path.join(dir, 'learning.db');
  const other = new DatabaseSync(file);
  other.exec('CREATE TABLE someone_elses (x)');
  other.close();
  const before = fs.readFileSync(file);
  const plugin = fakeContext({ file });
  const messages = [userMessage('hi')];
  assert.deepEqual(await step(plugin.preStep, 's1', { messages }), { kind: 'proceed', messages });
  assert.deepEqual(fs.readFileSync(file), before);
  plugin.dispose();
});

test('turnNote marks the announcement only after building the note', () => {
  const store = new LearningStore(':memory:');
  store.setSessionMode({ sessionId: 's1', mode: 'qa' });
  assert.throws(() => turnNote(store, 's1', [], { skillDir: temp('dsh-learning-noskills-') }), /ENOENT/);
  assert.equal(store.getSessionMode({ sessionId: 's1' }).announced, null);
  assert.ok(turnNote(store, 's1', []));
  assert.equal(store.getSessionMode({ sessionId: 's1' }).announced, 'qa');
  assert.equal(turnNote(store, 'other', []), undefined);
  store.close();
});

test('modes.list names each mode and its skill', async () => {
  const plugin = fakeContext({ file: library() });
  assert.deepEqual((await post(plugin.routes, 'modes.list')).body.result, [
    { id: 'qa', skill: 'learning-qa' }, { id: 'socratic', skill: 'learning-socratic' }, { id: 'quiz', skill: 'learning-quiz' },
  ]);
  plugin.dispose();
});

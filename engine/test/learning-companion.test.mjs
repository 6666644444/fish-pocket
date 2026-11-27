import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import {
  EPISODE, NOTE_SOURCE, REACH_SOURCE, freshness, openThread, parseDigest, parseOpener, planReach, recallEpisodes,
  standingTraits, transcript, whenSaid,
} from '../plugins/learning/companion.mjs';
import { conversationLines } from '../plugins/learning/companion-runtime.mjs';
import { DAY_MS } from '../plugins/learning/quiz.mjs';
import { LearningStore, SCHEMA_VERSION } from '../plugins/learning/store.mjs';
import { dumpLibrary, importLibrary } from '../plugins/learning/portable.mjs';

const HOUR = 3_600_000;
/** 2026-11-27 12:00 UTC = 20:00 in China. */
const T0 = Date.UTC(2026, 10, 27, 12);
const CN = 480;

const ep = (over) => ({ id: 1, text: '我们聊了很久', cues: [], importance: 0.5, emotion: 0.3, happenedAt: T0, recalls: 0, lastRecalledAt: null, supersededBy: null, hidden: false, ...over });

// Pure logic

test('freshness halves in 21 days for an ordinary episode, faster for a passing remark, slower when important or recalled', () => {
  assert.equal(freshness(ep({ importance: 0.5 }), T0), 1);
  assert.ok(Math.abs(freshness(ep({ importance: 0.5 }), T0 + 21 * DAY_MS) - 0.5) < 1e-9);
  assert.ok(Math.abs(freshness(ep({ importance: 1 }), T0 + 42 * DAY_MS) - 0.5) < 1e-9, 'important: H = 42 days');
  assert.ok(Math.abs(freshness(ep({ importance: 0 }), T0 + 10.5 * DAY_MS) - 0.5) < 1e-9, 'a passing remark: H = 10.5 days');
  assert.ok(freshness(ep({ importance: 0.5, recalls: 3 }), T0 + 21 * DAY_MS) > 0.6, 'recalled: lasts longer');
});

test('recall needs evidence: a rare word the user said, not a common one; fresh, current, not just shown', () => {
  const episodes = [
    ep({ id: 1, text: '那天晚上 ta 说数学月考没考好，我陪 ta 聊到很晚', cues: ['数学', '月考'], importance: 0.7, emotion: 0.7 }),
    ep({ id: 2, text: '我们一起吐槽食堂的饭', cues: ['食堂'] }),
    ep({ id: 3, text: '我们聊今天天气', cues: ['天气'] }),
    ep({ id: 4, text: 'ta 说今天天气不错，我们聊了今天的天气', cues: ['天气'] }),
  ];
  const now = T0 + 2 * DAY_MS;
  assert.deepEqual(recallEpisodes(episodes, '这次月考成绩出来了', { now }).map((e) => e.id), [1]);
  assert.deepEqual(recallEpisodes(episodes, '在吗', { now }), [], 'nothing shared: nothing comes to mind');
  assert.deepEqual(recallEpisodes(episodes, '今天', { now }), [], 'a word every episode has is no evidence');
  assert.deepEqual(recallEpisodes(episodes, '月考', { now, shown: new Set([1]) }), [], 'once per conversation');
  assert.deepEqual(recallEpisodes(episodes.map((e) => (e.id === 1 ? { ...e, lastRecalledAt: now - DAY_MS } : e)), '月考', { now }), [], 'a pause after being recalled');
  assert.deepEqual(recallEpisodes(episodes.map((e) => (e.id === 1 ? { ...e, supersededBy: 9 } : e)), '月考', { now }), [], 'superseded: history, not now');
  assert.deepEqual(recallEpisodes(episodes.map((e) => ({ ...e, importance: 0 })), '月考', { now: T0 + 120 * DAY_MS }), [], 'faded below the floor: kept, not recalled');
  assert.ok(recallEpisodes(episodes, '月考 食堂', { now }).length <= EPISODE.recallMax);
});

test('an open thread is asked about once, after a break, within three days', () => {
  const thread = ep({ id: 7, text: 'ta 说周五要数学月考，有点慌', followUp: '周五数学月考', happenedAt: T0 });
  assert.equal(openThread([thread], { now: T0 + HOUR, tzOffset: CN }), undefined, 'same evening: not yet');
  assert.equal(openThread([thread], { now: T0 + DAY_MS, tzOffset: CN })?.id, 7);
  assert.equal(openThread([{ ...thread, followedUpAt: T0 + DAY_MS }], { now: T0 + 2 * DAY_MS, tzOffset: CN }), undefined, 'asked already');
  assert.equal(openThread([thread], { now: T0 + 4 * DAY_MS, tzOffset: CN }), undefined, 'too long ago to bring up');
});

test('when, as a friend says it, in the phone zone', () => {
  assert.equal(whenSaid(T0, T0, CN), '今天晚上');
  assert.equal(whenSaid(T0 - DAY_MS, T0, CN), '昨天晚上');
  assert.equal(whenSaid(T0 - 2 * DAY_MS - 10 * HOUR, T0, CN), '前天早上');
  assert.equal(whenSaid(T0 - 4 * DAY_MS, T0, CN), '四天前');
  assert.equal(whenSaid(T0 - 9 * DAY_MS, T0, CN), '上周');
  assert.equal(whenSaid(Date.UTC(2026, 9, 3, 4), T0, CN), '10月3日');
  assert.equal(whenSaid(Date.UTC(2025, 9, 3, 4), T0, CN), '2025年10月3日');
});

test('the digest answer is checked: JSON in a fence, values clamped, a key with a value dropped, junk is empty', () => {
  const answer = '```json\n' + JSON.stringify({
    episodes: [
      { text: '晚上 ta 跟我说数学月考没考好，有点想哭，我陪 ta 把错题过了一遍，最后 ta 笑了', cues: ['数学', '月考', '错题'], importance: 3, emotion: 0.8, mood: '沮丧', key: 'ta.数学成绩', followUp: '下周订正' },
      { text: '太短', cues: [] },
      { text: '我们约好周末一起看那部电影，ta 说一定要看完', cues: ['电影'], key: 'ta.身高170' },
    ],
    traits: [{ key: '压力来时', text: '压力大时会先自嘲再说真话', evidence: '说"我真是个废物哈哈"之后才说想哭' }, { key: '', text: 'x', evidence: 'y' }],
    mood: { word: '沮丧', valence: -3 },
    retract: ['前任', 'x'],
  }) + '\n```';
  const d = parseDigest(answer);
  assert.equal(d.episodes.length, 2);
  assert.equal(d.episodes[0].importance, 1);
  assert.equal(d.episodes[0].key, 'ta.数学成绩');
  assert.equal(d.episodes[1].key, '', 'a key holding a value is no key');
  assert.equal(d.traits.length, 1);
  assert.deepEqual(d.mood, { word: '沮丧', valence: -1 });
  assert.deepEqual(d.retract, ['前任']);
  assert.deepEqual(parseDigest('I cannot help'), { episodes: [], traits: [], mood: null, retract: [] });
});

test('traits count only when seen on two days, until refuted or not seen for 60 days', () => {
  const t = (days, over) => ({ key: 'k', text: 't', days, lastSeen: T0, refuted: false, ...over });
  assert.equal(standingTraits([t([T0])], T0).length, 0, 'one day is an impression, not a trait');
  assert.equal(standingTraits([t([T0, T0 + DAY_MS])], T0).length, 1);
  assert.equal(standingTraits([t([T0, T0 + DAY_MS], { refuted: true })], T0).length, 0);
  assert.equal(standingTraits([t([T0, T0 + DAY_MS])], T0 + 61 * DAY_MS).length, 0, 'retired');
});

test('speaking first: never in quiet hours, one a day, the dice decides, ignored reaches back off', () => {
  const always = () => 0; // first draw: under the chance; second: start of the window
  const base = { now: T0, tzOffset: CN, lastUserAt: T0, quietStart: 23, quietEnd: 8, random: always };
  // 20:00 China + 6 h after talking = 02:00, quiet until 08:00.
  const plan = planReach(base);
  const hour = new Date(plan.fireAt + CN * 60_000).getUTCHours();
  assert.equal(hour, 8);
  assert.deepEqual(planReach({ ...base, random: () => 0.99 }), { skip: 'dice' });
  assert.deepEqual(planReach({ ...base, ignored: 4 }), { skip: 'ignored' });
  assert.deepEqual(planReach({ ...base, lastUserAt: null }), { skip: 'never-talked' });
  assert.ok(planReach({ ...base, ignored: 2 }).fireAt - plan.fireAt >= 3 * DAY_MS - HOUR, 'two ignored: three days later');
  assert.ok(planReach({ ...base, lastReachAt: plan.fireAt - HOUR }).fireAt >= plan.fireAt + DAY_MS - HOUR, 'one a day');
  assert.equal(parseOpener('SKIP'), '');
  assert.equal(parseOpener('在吗？'), '');
  assert.equal(parseOpener('「月考成绩出来没？」'), '月考成绩出来没？');
});

test('the transcript keeps who said what, newest kept when long', () => {
  const lines = conversationLines([
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我今天好累' }] },
    { role: 'user', source: { kind: NOTE_SOURCE }, content: [{ type: 'text', text: '【Firefly 伙伴】…' }] },
    { role: 'assistant', content: [{ type: 'text', text: '怎么啦' }] },
  ]);
  assert.deepEqual(lines, [{ role: 'user', text: '我今天好累' }, { role: 'assistant', text: '怎么啦' }]);
  assert.equal(transcript(lines, { botName: '小萤' }), 'ta：我今天好累\n我（小萤）：怎么啦');
});

// The store

test('schema 10+: episodes with a fact key replace the older state; traits gather days; retract hides', () => {
  let now = T0;
  const store = new LearningStore(':memory:', { now: () => now });
  assert.ok(SCHEMA_VERSION >= 10);
  store.useClock(CN);
  store.saveDigest({ botId: 'b1', digest: { episodes: [{ text: 'ta 说最近都是一点才睡，第二天上课犯困', cues: ['熬夜'], importance: 0.5, emotion: 0.3, key: 'ta.作息' }], traits: [{ key: '作息', text: '习惯熬夜', evidence: '说一点才睡' }], mood: null, retract: [] } });
  now += DAY_MS;
  const second = store.saveDigest({ botId: 'b1', digest: { episodes: [{ text: 'ta 说这周开始十一点就睡了，早上精神好多了', cues: ['早睡'], importance: 0.5, emotion: 0.4, key: 'ta.作息' }], traits: [{ key: '作息', text: '在努力早睡', evidence: '说十一点睡' }], mood: { word: '开心', valence: 0.6 }, retract: [] } });
  const live = store.companionEpisodes({ botId: 'b1' });
  assert.deepEqual(live.map((e) => e.text.startsWith('ta 说这周开始十一点')), [true], 'the old state is history now');
  assert.equal(store.companionEpisodes({ botId: 'b1', all: true }).find((e) => e.key === 'ta.作息' && e.id !== second.episodes[0]).supersededBy, second.episodes[0]);
  const [trait] = store.companionTraits({ botId: 'b1' });
  assert.deepEqual({ text: trait.text, days: trait.days.length }, { text: '在努力早睡', days: 2 });
  assert.equal(standingTraits(store.companionTraits({ botId: 'b1' }), now).length, 1);
  store.refuteTrait({ botId: 'b1', key: '作息' });
  assert.equal(standingTraits(store.companionTraits({ botId: 'b1', all: true }), now).length, 0, 'refuted by the user');
  store.saveDigest({ botId: 'b1', digest: { episodes: [], traits: [], mood: null, retract: ['早睡'] } });
  assert.deepEqual(store.companionEpisodes({ botId: 'b1' }), [], 'ta asked to forget it');
  assert.equal(store.companionEpisodes({ botId: 'b1', all: true }).length, 2, 'hidden, not deleted');
  store.close();
});

test('the companion data goes with an export and comes back', () => {
  const a = new LearningStore(':memory:', { now: () => T0 });
  a.saveDigest({ botId: 'b1', digest: { episodes: [{ text: '我们第一次聊到 ta 喜欢的乐队', cues: ['乐队'], importance: 0.6, emotion: 0.5 }], traits: [{ key: '音乐', text: '喜欢摇滚', evidence: '聊乐队' }], mood: { word: '兴奋', valence: 0.7 }, retract: [] } });
  const data = JSON.parse(JSON.stringify(dumpLibrary(a)));
  const b = new LearningStore(':memory:', { now: () => T0 });
  importLibrary(b, data);
  assert.equal(b.companionEpisodes({ botId: 'b1' })[0].text, '我们第一次聊到 ta 喜欢的乐队');
  assert.equal(b.companionTraits({ botId: 'b1' })[0].key, '音乐');
  assert.equal(b.companionMoods({ botId: 'b1' })[0].word, '兴奋');
  a.close();
  b.close();
});

// The plugin, with a fake team, agents and model

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-'));
  const teamPath = path.join(dir, 'state.json');
  fs.writeFileSync(teamPath, JSON.stringify({ bots: {
    b1: { id: 'b1', name: '小萤', sessionId: 's1', role: '朋友', instructions: '说话随意，爱吐槽' },
    b2: { id: 'b2', name: '助手', sessionId: 's2' },
  } }));
  const clock = { now: T0 };
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const timers = [];
  const calls = [];
  const answers = [];
  const history = new Map([['s1', []], ['s2', []]]);
  const followups = [];
  const agent = (id) => ({
    id,
    session: { id, header: {}, deriveMessages: () => history.get(id), requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    followup: (message) => followups.push({ id, message }),
  });
  const agents = { get: (id) => (history.has(id) ? agent(id) : undefined) };
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: (name, handler) => handlers.set(name, handler),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: () => () => {} },
  };
  new Learning(ctx, {
    file: path.join(dir, 'learning', 'l.db'), teamFile: teamPath, embedder: null, agents,
    storeOptions: { now: () => clock.now }, services: { llm: {} }, random: () => 0,
    timers: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {} },
    callModel: async (_llm, _target, request) => { calls.push(request); return answers.shift() ?? '{}'; },
  });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return (await response.json()).result;
  };
  const say = async (id, text) => {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
    const decision = await handlers.get('agent/pre-step')({ agent: agent(id), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [message] }));
    history.get(id).push(message);
    return decision.messages.filter((m) => m.source?.kind === NOTE_SOURCE).map((m) => m.content[0].text).join('\n');
  };
  const reply = (id, text) => history.get(id).push({ role: 'assistant', content: [{ type: 'text', text }] });
  return {
    clock, post, say, reply, answers, calls, timers, followups, history, agent,
    // The phone's clock, as the app sends it (China time).
    ready: () => post('companion.wake', { tzOffset: CN }),
    dispose: () => disposers.reverse().forEach((d) => d()),
  };
}

const digestAnswer = (over = {}) => JSON.stringify({
  episodes: [{ text: '晚上 ta 跟我说周五数学月考，最近复习到很晚，有点慌，我让 ta 先把错题本过一遍', cues: ['数学', '月考', '错题本'], importance: 0.7, emotion: 0.6, mood: '紧张', followUp: '周五数学月考' }],
  traits: [{ key: '压力来时', text: '紧张时说话会变快、爱自嘲', evidence: '连发几条说自己完蛋了' }],
  mood: { word: '紧张', valence: -0.4 },
  retract: [],
  ...over,
});

test('only the chosen Bot is a companion; its first turn gets how to talk, once per conversation part', async () => {
  const h = harness();
  assert.equal(await h.say('s1', '在吗'), '', 'no companion chosen yet: nothing changes');
  await h.post('companion.settings.set', { botId: 'b1' });
  assert.equal(await h.say('s2', '你好'), '', 'another Bot: untouched');
  const first = await h.say('s1', '今天好累啊');
  assert.match(first, /【Firefly 伙伴】/);
  assert.match(first, /不是客服/);
  assert.doesNotMatch(await h.say('s1', '算了不说了'), /【Firefly 伙伴】/, 'given once: the prompt stays the same afterwards');
  h.dispose();
});

test('a conversation becomes an episode; days later the same subject brings it to mind, and an open thread is asked about', async () => {
  const h = harness();
  await h.ready();
  await h.post('companion.settings.set', { botId: 'b1' });
  await h.say('s1', '周五数学月考，我感觉要完蛋了，最近每天复习到一点');
  h.reply('s1', '先别慌，把错题本过一遍？');
  await h.say('s1', '好吧，我试试，谢谢你');
  h.answers.push(digestAnswer());
  // Idle: the timer the turn armed fires.
  assert.equal(h.timers.at(-1).ms, 20 * 60_000);
  h.timers.at(-1).fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].user, /ta：周五数学月考/);
  assert.match(h.calls[0].user, /我（小萤）：先别慌/);
  const [episode] = await h.post('companion.episodes', {});
  assert.equal(episode.followUp, '周五数学月考');

  // The next day, a new conversation part (s1 stays the Session in this fake).
  h.clock.now = T0 + DAY_MS;
  const next = await h.say('s1', '早');
  assert.match(next, /【还没聊完的事】/, 'a break: the thread comes up');
  assert.doesNotMatch(next, /【脑子里浮现的往事】/, '"早" brings nothing to mind');
  h.clock.now += 5 * 60_000;
  const related = await h.say('s1', '月考成绩出来了，数学比上次高了十分');
  assert.match(related, /【脑子里浮现的往事】/);
  assert.match(related, /昨天晚上/);
  assert.match(related, /别说"我记得"/);
  assert.doesNotMatch(await h.say('s1', '月考真的好难'), /往事/, 'shown once per conversation');
  h.dispose();
});

test('two days of the same trait make it known; the session note carries it', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'b1' });
  for (const day of [0, 1]) {
    h.clock.now = T0 + day * DAY_MS;
    h.history.set('s1', []);
    await h.say('s1', '啊啊啊我又要完蛋了哈哈，这次物理也没复习');
    h.reply('s1', '哈哈你每次都这么说');
    h.answers.push(digestAnswer({ episodes: [] }));
    await h.post('companion.digest', {});
  }
  const status = await h.post('companion.status', {});
  assert.equal(status.traits.length, 1);
  assert.equal(status.traits[0].text, '紧张时说话会变快、爱自嘲');
  assert.equal(status.mood.word, '紧张');
  h.dispose();
});

test('speaking first: planned when the phone leaves, said when it comes back, called off when the user comes first', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'b1' });
  assert.deepEqual(await h.post('companion.plan', { tzOffset: CN, allowed: true }), { skip: 'never-talked' });
  await h.say('s1', '周五数学月考，紧张');
  h.reply('s1', '加油');
  h.clock.now += 3 * HOUR;
  assert.equal((await h.post('companion.plan', { tzOffset: CN })).skip, 'thought-recently', 'thought about at most every 6 hours');
  h.clock.now += 4 * HOUR;
  h.answers.push('「明天就考了，今晚早点睡？」');
  const { plan } = await h.post('companion.plan', { tzOffset: CN, allowed: true });
  assert.equal(plan.text, '明天就考了，今晚早点睡？');
  assert.equal(plan.botName, '小萤');
  assert.match(h.calls.at(-1).user, /说话随意，爱吐槽/, 'in its own voice');
  assert.equal((await h.post('companion.plan', { tzOffset: CN })).plan.id, plan.id, 'one at a time, no new model call');
  assert.equal(h.calls.length, 1);

  assert.deepEqual((await h.post('companion.wake', { tzOffset: CN })).delivered, [], 'not yet');
  h.clock.now = plan.fireAt + 10 * 60_000;
  const woke = await h.post('companion.wake', { tzOffset: CN });
  assert.deepEqual(woke.delivered, [plan.id]);
  assert.equal(h.followups.length, 1);
  assert.equal(h.followups[0].id, 's1');
  assert.equal(h.followups[0].message.source.kind, REACH_SOURCE);
  assert.match(h.followups[0].message.content[0].text, /明天就考了，今晚早点睡？/);
  h.clock.now += HOUR;
  await h.say('s1', '嗯嗯睡了');
  assert.ok((await h.post('companion.status', {})).planned === null);

  // Planned again later; the user writes first: the notification is taken back.
  h.clock.now += 7 * HOUR;
  h.answers.push('考得怎么样？');
  const again = await h.post('companion.plan', { tzOffset: CN });
  assert.ok(again.plan, JSON.stringify(again));
  await h.say('s1', '我考完啦');
  assert.deepEqual((await h.post('companion.wake', { tzOffset: CN })).cancelled, [again.plan.id]);
  h.dispose();
});

test('a reach seen too late is dropped; the switch and the notification permission are respected', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'b1' });
  await h.say('s1', '晚安');
  h.clock.now += 7 * HOUR;
  h.answers.push('醒了没');
  const { plan } = await h.post('companion.plan', { tzOffset: CN });
  h.clock.now = plan.fireAt + 19 * HOUR;
  assert.deepEqual((await h.post('companion.wake', { tzOffset: CN })).expired, [plan.id]);
  assert.equal(h.followups.length, 0);
  assert.deepEqual(await h.post('companion.plan', { tzOffset: CN, allowed: false }), { skip: 'no-notifications' });
  await h.post('companion.settings.set', { reach: false });
  assert.deepEqual(await h.post('companion.plan', { tzOffset: CN }), { skip: 'off' });
  h.dispose();
});

// A month together, simulated: what is remembered, what fades, what changes.
test('a month together: important things stay, small things fade, a changed habit replaces the old one', async () => {
  let now = T0;
  const store = new LearningStore(':memory:', { now: () => now });
  store.useClock(CN);
  const keep = (episode) => store.saveDigest({ botId: 'b1', digest: { episodes: [episode], traits: [], mood: null, retract: [] } });
  keep({ text: 'ta 第一次跟我说起爸妈吵架的事，说了很久，最后说谢谢我听 ta 说完', cues: ['爸妈', '吵架'], importance: 0.95, emotion: 0.9 });
  keep({ text: '我们随口聊了食堂今天的土豆丝太咸', cues: ['食堂', '土豆丝'], importance: 0.1, emotion: 0.1 });
  keep({ text: 'ta 说自己每天一点才睡', cues: ['熬夜'], importance: 0.4, emotion: 0.2, key: 'ta.作息' });
  now += 10 * DAY_MS;
  keep({ text: 'ta 说开始十一点睡了，白天上课不困了', cues: ['早睡'], importance: 0.4, emotion: 0.4, key: 'ta.作息' });
  now = T0 + 70 * DAY_MS;
  const all = store.companionEpisodes({ botId: 'b1' });
  assert.deepEqual(recallEpisodes(all, '我爸妈今天又吵架了', { now }).map((e) => e.cues[0]), ['爸妈'], 'what mattered is still there after 70 days');
  assert.deepEqual(recallEpisodes(all, '食堂的土豆丝', { now }), [], 'a passing remark has faded');
  assert.deepEqual(recallEpisodes(all, '最近熬夜吗 早睡', { now: T0 + 12 * DAY_MS }).map((e) => e.cues[0]), ['早睡'], 'only the current habit');
  store.close();
});

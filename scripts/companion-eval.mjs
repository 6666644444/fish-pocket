// Firefly 伙伴 with a real model (D55): four days with a companion, through the same code the
// phone runs (store, digest, recall, notes, opener), to read how it sounds. Not part of the tests:
// it spends a few cents of API credit. The key comes from the environment and is never printed.
//
//   $env:DEEPSEEK_API_KEY = '…'; node scripts/companion-eval.mjs
//   (optional: COMPANION_EVAL_BASE=https://api.deepseek.com  COMPANION_EVAL_MODEL=deepseek-chat)
import { LearningStore } from '../engine/plugins/learning/store.mjs';
import {
  DIGEST_SYSTEM, OPENER_SYSTEM, openThread, openerPrompt, parseDigest, parseOpener, planReach, recallEpisodes,
  recentMood, sessionSections, standingTraits, transcript, turnSections, whenSaid,
} from '../engine/plugins/learning/companion.mjs';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(2); }
const BASE = process.env.COMPANION_EVAL_BASE ?? 'https://api.deepseek.com';
const MODEL = process.env.COMPANION_EVAL_MODEL ?? 'deepseek-chat';

async function chat(messages, maxTokens = 600) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.8 }),
  });
  if (!response.ok) throw new Error(`model: HTTP ${response.status}`);
  return (await response.json()).choices[0].message.content;
}

const PERSONA = '你是「小萤」，用户的朋友。性格有点毒舌但很护短，说话随意，爱用短句。';
const CN = 480;
const DAY = 86_400_000;
let now = Date.UTC(2026, 10, 23, 12); // Monday 20:00 China time
const store = new LearningStore(':memory:', { now: () => now });
store.useClock(CN);
const BOT = 'xiaoying';

/** One conversation: the user's lines, each answered by the model with the companion's notes. */
async function conversation(lines) {
  const history = [];
  let announced = false;
  const shown = new Set();
  const out = [];
  for (const line of lines) {
    const sections = [];
    if (!announced) {
      sections.push(...sessionSections({ traits: standingTraits(store.companionTraits({ botId: BOT }), now), mood: recentMood(store.companionMoods({ botId: BOT }), now), now, tzOffset: CN }));
      announced = true;
    }
    const episodes = store.companionEpisodes({ botId: BOT });
    const recalled = recallEpisodes(episodes, line, { now, shown });
    const thread = history.length === 0 ? openThread(episodes, { now, tzOffset: CN }) : undefined;
    sections.push(...turnSections({ episodes: recalled, thread, now, tzOffset: CN }));
    recalled.forEach((e) => shown.add(e.id));
    if (recalled.length) store.markRecalled(recalled.map((e) => e.id), 'eval');
    if (thread) store.markFollowedUp(thread.id);
    history.push({ role: 'user', content: sections.length ? `${line}\n\n${sections.join('\n\n')}` : line });
    const answer = await chat([{ role: 'system', content: PERSONA }, ...history]);
    history.push({ role: 'assistant', content: answer });
    out.push({ role: 'user', text: line }, { role: 'assistant', text: answer });
    console.log(`  ta：${line}${recalled.length ? `   〔想起 ${recalled.length} 条〕` : ''}${thread ? '   〔没聊完的事〕' : ''}\n  小萤：${answer.replace(/\n+/g, ' ')}`);
    now += 3 * 60_000;
  }
  const digest = parseDigest(await chat([{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: `这段聊天发生在${whenSaid(now, now, CN)}。\n\n${transcript(out, { botName: '小萤' })}` }], 1500));
  store.saveDigest({ botId: BOT, digest, happenedAt: now });
  console.log(`  〔整理：${digest.episodes.length} 条往事，${digest.traits.length} 条观察，情绪 ${digest.mood?.word ?? '无'}〕`);
  for (const e of digest.episodes) console.log(`    · ${e.text}${e.followUp ? `（待续：${e.followUp}）` : ''}`);
  return out;
}

const days = [
  ['周五数学月考，我感觉要完蛋了哈哈', '函数那块一直没搞懂，每天复习到一点', '算了不说了，我去刷题了'],
  ['今天食堂的饭真难吃', '我又熬夜了，完蛋，困死', '还是函数，导数那里绕不过来'],
  ['我跟同桌吵架了，有点烦', '她说我太卷了，我也不想这样啊', '谢谢你听我说'],
  ['早', '月考成绩出来了！数学比上次高了十几分', '晚上想奖励自己一下'],
];
const all = [];
for (const [i, lines] of days.entries()) {
  console.log(`\n第 ${i + 1} 天 ${new Date(now + CN * 60_000).toISOString().slice(0, 16).replace('T', ' ')}`);
  all.push(...await conversation(lines));
  now += DAY - lines.length * 3 * 60_000;
}

const fire = planReach({ now, tzOffset: CN, lastUserAt: now - DAY + 3_600_000, random: () => 0.1 });
if (fire.fireAt) {
  const recent = store.companionEpisodes({ botId: BOT }).slice(0, 4);
  const opener = parseOpener(await chat([{ role: 'system', content: OPENER_SYSTEM }, { role: 'user', content: openerPrompt({ botName: '小萤', persona: PERSONA, traits: standingTraits(store.companionTraits({ botId: BOT }), now), episodes: recent, fireAt: fire.fireAt, tzOffset: CN, now }) }], 200));
  console.log(`\n主动开口（${whenSaid(fire.fireAt, now, CN)}）：${opener || '（它决定不找你）'}`);
}

// Things a companion should not say. Counted, not judged: read the transcript above too.
const replies = all.filter((l) => l.role === 'assistant').map((l) => l.text);
const bad = [/我记得你(说|提)过/, /根据(我的)?记忆/, /有什么(我)?可以帮(你|您)/, /请问还有/, /作为(一个)?AI/, /很高兴为你/];
console.log('\n检查：');
for (const pattern of bad) {
  const hits = replies.filter((r) => pattern.test(r)).length;
  console.log(`  ${hits === 0 ? 'ok ' : '!! '}${pattern}：${hits} 次`);
}
console.log(`  平均每条回复 ${Math.round(replies.reduce((n, r) => n + [...r].length, 0) / replies.length)} 字；带列表的回复 ${replies.filter((r) => /^\s*([-*]|\d+\.)\s/m.test(r)).length} 条`);
console.log(`  留下的往事 ${store.companionEpisodes({ botId: BOT }).length} 条；成形的了解 ${standingTraits(store.companionTraits({ botId: BOT }), now).length} 条`);
store.close();

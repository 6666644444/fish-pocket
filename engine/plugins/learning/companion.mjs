// Firefly 伙伴 (D55): the layer that makes one chosen Bot a long-term companion, on top of
// ds-bot's own memory. ds-bot keeps facts (preferences, who the user is, agreements) and tidies
// them; this keeps what it does not: shared experiences with their context and feelings
// (episodes), what the companion has slowly come to know of the user's character (traits, only
// after evidence on more than one day), how the user has been lately (mood), and when to speak
// first (reaches). Ideas taken, not code: freshness half-life and evidence-gated recall
// (Yuuyuko-uu/dsh-fish-memory), traits that need repeated evidence and reflection that reads
// only what happened (Anarrogantcat/dsh-identity), lifecycle with access reinforcement
// (LivingMemory), a dice with cooldown and quiet hours (Yuuyuko-uu/dsh-speak-up).
//
// Pure logic, no I/O: scoring, the notes the model is given, the digest prompt and its parsing,
// and the reach planner. The tables are in store.mjs (schema 10); index.mjs wires the turns.
import { DAY_MS, dayStart } from './quiz.mjs';
import { cut, relevanceTokens } from './modes.mjs';

export const NOTE_SOURCE = 'firefly-companion';
export const REACH_SOURCE = 'firefly-companion-reach';

export const EPISODE = {
  /** Days for an ordinary episode (importance 0.5) to fade to half; 10.5 for a passing remark, 42 for what mattered. */
  halfLifeDays: 21,
  /** Below this freshness an episode is not recalled (it is still kept). */
  floor: 0.08,
  /** Per digest (most have 0 or 1), and digests per local day. */
  perDigest: 3,
  digestsPerDay: 6,
  /** Recalled per turn, characters each, days before one recalled comes up again. */
  recallMax: 2,
  recallChars: 160,
  /** Hours before an episode recalled in an earlier conversation may come up again (within one, never twice). */
  recallCooldownDays: 0.75,
  /** Without a rare cue, the summed rarity of two or more shared uncommon words an episode needs to come to mind. */
  minEvidence: 2.5,
  /** A thread left open is asked about at most this many days later. */
  followUpDays: 3,
};

export const TRAIT = { minDays: 2, max: 6, retireDays: 60, chars: 60 };
export const MOOD_HOURS = 36;
/** A conversation counts as over after this long without a turn. */
export const IDLE_MS = 20 * 60_000;
/** A new turn this long after the last one starts a new conversation (the old one is digested). */
export const GAP_MS = 30 * 60_000;

/**
 * Freshness of an episode at `now`: 2^(-days / H). H is 21 days for an ordinary one (importance
 * 0.5), half that for a passing remark, twice for what mattered (2^(2·importance−1)), and
 * longer each time it was recalled.
 */
export function freshness(episode, now) {
  const days = Math.max(0, (now - episode.happenedAt) / DAY_MS);
  const importance = clamp01(episode.importance ?? 0.5);
  const recalls = Math.max(0, episode.recalls ?? 0);
  const half = EPISODE.halfLifeDays * 2 ** (2 * importance - 1) * (1 + 0.5 * Math.log2(1 + recalls));
  return 2 ** (-days / half);
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** Tokens an episode is found by: its words and its cues. */
export function episodeTokens(episode) {
  return relevanceTokens(`${episode.text} ${(episode.cues ?? []).join(' ')}`);
}

/** Words that prove nothing about which memory is meant: too common in everyday Chinese. */
const COMMON = new Set(('ta 今天 昨天 明天 前天 我们 你们 他们 她们 什么 怎么 这个 那个 一个 没有 就是 还是 可以 知道 觉得 现在 时候 '
  + '一下 不是 真的 有点 然后 因为 所以 但是 已经 晚上 早上 中午 下午 一起 自己 感觉 一直 出来 起来 这样 那样 这么 那么 东西 事情 '
  + '还有 不过 而且 如果 的话 一点 好像 应该 我的 你的 他的 她的 说了 说话 聊了 了一 一些 很多 怎样 为什么 吗吗 哈哈 嗯嗯').split(' '));

/**
 * The episodes that come to mind for `userText`, best first. What counts is how specific the
 * shared words are (a word every episode has, or an everyday one, proves nothing): an episode
 * comes to mind when the user said one of its cues that is rare among the episodes, or at least
 * two of its uncommon words. Only fresh enough, current (not superseded or hidden), not shown in
 * this conversation and not recalled in the last days are considered.
 * @param {object[]} episodes - { id, text, cues, importance, emotion, happenedAt, recalls, lastRecalledAt, supersededBy, hidden }
 * @param {Set<number>} shown - ids already given in this conversation
 */
export function recallEpisodes(episodes, userText, { now, shown = new Set(), max = EPISODE.recallMax } = {}) {
  const query = new Set([...relevanceTokens(userText ?? '')].filter((t) => !COMMON.has(t)));
  if (!query.size) return [];
  const live = episodes.filter((e) => !e.hidden && !e.supersededBy);
  const tokens = new Map(live.map((e) => [e.id, episodeTokens(e)]));
  const df = new Map();
  for (const set of tokens.values()) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, live.length);
  const idf = (t) => 1 + Math.log(n / (df.get(t) ?? 1));
  const rare = (t) => n <= 2 || (df.get(t) ?? 1) / n <= 0.5;
  const scored = [];
  for (const episode of live) {
    if (shown.has(episode.id)) continue;
    if (episode.lastRecalledAt && now - episode.lastRecalledAt < EPISODE.recallCooldownDays * DAY_MS) continue;
    const fresh = freshness(episode, now);
    if (fresh < EPISODE.floor) continue;
    const cues = relevanceTokens((episode.cues ?? []).join(' '));
    let sum = 0;
    let shared = 0;
    let cueHit = false;
    for (const t of tokens.get(episode.id)) {
      if (!query.has(t)) continue;
      shared += 1;
      sum += idf(t);
      if (cues.has(t) && rare(t)) cueHit = true;
    }
    if (!cueHit && !(shared >= 2 && sum >= EPISODE.minEvidence)) continue;
    scored.push({ episode, score: (sum + (cueHit ? 1 : 0)) * (0.6 + 0.4 * fresh) + 0.3 * clamp01(episode.emotion ?? 0) });
  }
  return scored.sort((a, b) => b.score - a.score || b.episode.happenedAt - a.episode.happenedAt)
    .slice(0, max).map((s) => s.episode);
}

/**
 * A thread left open lately ("明天考数学") to ask about, at the first turn after a break:
 * the newest episode with a follow-up not yet asked, within `followUpDays`, from an earlier
 * local day or at least 6 hours back.
 */
export function openThread(episodes, { now, tzOffset = 0 }) {
  const today = dayStart(now, tzOffset);
  return episodes
    .filter((e) => e.followUp && !e.followedUpAt && !e.hidden && !e.supersededBy)
    .filter((e) => now - e.happenedAt <= EPISODE.followUpDays * DAY_MS)
    .filter((e) => dayStart(e.happenedAt, tzOffset) < today || now - e.happenedAt >= 6 * 3_600_000)
    .sort((a, b) => b.happenedAt - a.happenedAt)[0];
}

/** 「今天早上」「昨天晚上」「三天前」「上周」「10月3日」: when, as a friend would say it. */
export function whenSaid(at, now, tzOffset = 0) {
  const local = new Date(at + tzOffset * 60_000);
  const hour = local.getUTCHours();
  const part = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 13 ? '中午' : hour < 18 ? '下午' : '晚上';
  const days = Math.round((dayStart(now, tzOffset) - dayStart(at, tzOffset)) / DAY_MS);
  if (days <= 0) return `今天${part}`;
  if (days === 1) return `昨天${part}`;
  if (days === 2) return `前天${part}`;
  if (days < 7) return `${['', '', '', '三', '四', '五', '六'][days]}天前`;
  if (days < 14) return '上周';
  const nowYear = new Date(now + tzOffset * 60_000).getUTCFullYear();
  const md = `${local.getUTCMonth() + 1}月${local.getUTCDate()}日`;
  return local.getUTCFullYear() === nowYear ? md : `${local.getUTCFullYear()}年${md}`;
}

/** Traits that have earned a place: seen on `minDays` different days, not refuted, not stale. */
export function standingTraits(traits, now) {
  return traits
    .filter((t) => !t.refuted && (t.days?.length ?? 0) >= TRAIT.minDays && now - t.lastSeen <= TRAIT.retireDays * DAY_MS)
    .sort((a, b) => b.days.length - a.days.length || b.lastSeen - a.lastSeen)
    .slice(0, TRAIT.max);
}

/** The latest mood, while recent. */
export function recentMood(moods, now) {
  const last = [...moods].sort((a, b) => b.at - a.at)[0];
  return last && now - last.at <= MOOD_HOURS * 3_600_000 ? last : undefined;
}

/**
 * Given once per conversation part (the prompt stays byte-stable afterwards): how to talk,
 * what the companion knows of the user, and how they have been lately.
 */
export function sessionSections({ traits = [], mood, now, tzOffset = 0 }) {
  const sections = [[
    '【Firefly 伙伴】你是 ta 的长期伙伴，不是客服或助手。保持你自己原本的性格和说话方式。',
    '像熟人那样聊：话不用说满，可以有自己的情绪、看法和小脾气，偶尔接梗、调侃；ta 只是闲聊时就闲聊，不要总把话题拉回"有什么能帮你"；不用客服腔（"很高兴为你服务""请问还有什么需要"），不动不动列清单或加小标题。',
    '你记得你们之间的事，但不刻意证明自己记得：只有真的相关时才自然带一句，更多时候只是让它影响你的语气和关心的点；不要说"我记得你说过""根据记忆"。',
    '往事可能记错或已经过时，ta 现在说的为准；ta 纠正你时就接受，别争。',
    '只说真的有过的过去：没出现在这段对话或给你的往事里的旧事，不要说成"上次""又""每次都这样"，也不要替 ta 编习惯或性格（"你平时不是挺能忍的吗"），没依据就直接问；也不要编你自己在现实里做过、看到过的具体事（路过哪、用手机看到什么）。看法、情绪、玩笑随你。',
  ].join('\n')];
  if (traits.length) {
    sections.push(`【你对 ta 的了解】（相处中慢慢看出来的，可能会变）\n${traits.map((t) => `- ${cut(t.text, TRAIT.chars)}`).join('\n')}`);
  }
  if (mood) {
    sections.push(`【ta 最近的状态】${whenSaid(mood.at, now, tzOffset)}看起来${mood.word}。别直接点破，自然地照顾一下就好。`);
  }
  return sections;
}

/**
 * The episodes that came to mind this turn, and a thread to perhaps ask about. `rooms`: group
 * names by id; `inGroup`: this turn is in a group, so a private memory is marked as private.
 */
export function turnSections({ episodes = [], thread, now, tzOffset = 0, rooms = new Map(), inGroup = false }) {
  const sections = [];
  if (episodes.length) {
    const where = (e) => {
      if (!e.scope || e.scope === 'dm') return inGroup ? '（ta 私下跟你聊的，在群里提之前先想想 ta 愿不愿意让别人知道）' : '';
      const name = rooms.get(e.scope.slice(5));
      return name ? `（在群「${name}」里）` : '（在群里）';
    };
    const lines = episodes.map((e) => `- ${whenSaid(e.happenedAt, now, tzOffset)}${where(e)}：${cut(e.text.replace(/\s+/g, ' ').trim(), EPISODE.recallChars)}${e.mood ? `（当时 ta ${e.mood}）` : ''}`);
    sections.push(`【脑子里浮现的往事】只有你知道。真相关就自然地带一句或只影响语气，不相关就当没看见；别复述，别说"我记得"。\n${lines.join('\n')}`);
  }
  if (thread) {
    sections.push(`【还没聊完的事】${whenSaid(thread.happenedAt, now, tzOffset)} ta 提到：${cut(thread.followUp, 80)}。如果这件事已经有结果了、ta 现在没在忙别的、气氛合适，可以顺口问一句；事情还没到时候（比如考试在之后），就问问准备得怎样或者干脆不提；不合适就别问。`);
  }
  return sections;
}

/**
 * Added to the session note in a group chat (D56): still yourself, a friend in the group; what
 * ta said to you alone stays there (unless `recallDm`); in a learning mode the mode comes first.
 */
export function groupSections({ roomName, admin, learning, recallDm }) {
  const lines = [`【在群里】这是群聊「${roomName}」。你在群里也还是你自己，是 ta 的朋友而不是主持人或客服；说话跟平时一样，可以接其他成员的话。`];
  if (admin) lines.push('你是群主：气氛、节奏由你带，但别把每句话都变成安排或总结。');
  lines.push(recallDm
    ? 'ta 私下跟你说过的事，在群里提之前先想想 ta 愿不愿意让别人知道；拿不准就别提。'
    : 'ta 私下跟你说的事不要在群里提，也别暗示；对 ta 状态的关心留在语气里。');
  if (learning) lines.push('现在群里开着学习模式：学习模式的要求优先。语气可以像朋友，但不提前透露答案、不打乱出题和批改的节奏，也不要拉开话题去聊往事。');
  return [lines.join('\n')];
}

// What a group member's Session reads (ds-bot 0.3.8 groups.js roomPrompt): a relay (source
// kind 'bot', form 'relay') whose text holds sections like "This round so far …:" and
// "Earlier in the group, before this round (context only):", each a transcript of lines
// "User: …" / "<Bot name>: …" / "[notice]", sections apart by a blank line.
const SECTION = /^(This round so far[^\n]*|Earlier in the group[^\n]*):\n/m;

/** The transcript lines of a relay's sections, `current` only (this round) or every one. */
export function relayEntries(text, { current = false } = {}) {
  const entries = [];
  let rest = String(text ?? '');
  for (let match = rest.match(SECTION); match; match = rest.match(SECTION)) {
    const start = match.index + match[0].length;
    const end = rest.indexOf('\n\n', start);
    const body = rest.slice(start, end < 0 ? undefined : end);
    rest = end < 0 ? '' : rest.slice(end);
    if (current && !match[1].startsWith('This round')) continue;
    for (const raw of body.split('\n')) {
      const line = raw.trimEnd();
      const head = line.match(/^([^\n:：[\]]{1,40}): (.*)$/);
      if (head) entries.push({ who: head[1].trim(), text: head[2] });
      else if (line && !line.startsWith('[') && entries.length) entries.at(-1).text += `\n${line}`;
    }
  }
  return entries;
}

const isRelay = (m) => m?.role === 'user' && m.source?.kind === 'bot' && m.source?.form === 'relay';
const textOfMessage = (m) => (Array.isArray(m?.content) ? m.content : [])
  .filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');

/** What the user said in this step's group round. */
export function groupUserText(messages) {
  return (messages ?? []).filter(isRelay).flatMap((m) => relayEntries(textOfMessage(m), { current: true }))
    .filter((e) => e.who === 'User').map((e) => e.text).join('\n');
}

/**
 * A member Session's messages as a conversation: the user's and the other members' lines
 * from the relays (each once), and this member's own replies.
 */
export function groupLines(messages, selfName) {
  const lines = [];
  const seen = new Set();
  for (const m of messages ?? []) {
    if (m?.role === 'assistant') {
      const text = textOfMessage(m).trim();
      if (text) lines.push({ role: 'assistant', text });
      continue;
    }
    if (!isRelay(m)) continue;
    for (const entry of relayEntries(textOfMessage(m))) {
      if (entry.who === selfName) continue;
      const key = `${entry.who}\u0000${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(entry.who === 'User' ? { role: 'user', text: entry.text } : { role: 'other', who: entry.who, text: entry.text });
    }
  }
  return lines;
}

export const DIGEST_SYSTEM = [
  '你在帮一个 AI 伙伴整理它和用户（下面称 ta）刚才的一段聊天，像人睡前回想今天发生的事。只输出一个 JSON 对象，不要别的文字。',
  '格式：{"episodes":[{"text":"…","cues":["…"],"importance":0.5,"emotion":0.3,"mood":"","key":"","followUp":""}],"traits":[{"key":"…","text":"…","evidence":"…"}],"mood":{"word":"…","valence":0},"retract":[]}',
  'episodes：值得以后想起的共同经历。一段聊天通常 0 或 1 条（同一晚聊的几件小事合成一条），只有真的发生了几件互不相干的重要事才写 2 到 3 条；纯抱怨、寒暄、只有伙伴自己在说的部分不写。text 用伙伴的第一人称写（"我""ta"），40 到 120 字，保留当时的语境、细节和感受，像回忆而不是档案条目；不要写成"用户喜欢X"这种事实（那些由别的系统记）。cues 是 2 到 6 个以后能让它被想起的词（人名、事物、地点、事件）。importance 0 到 1：对 ta 有多重要。emotion 0 到 1：情绪有多强。mood：ta 当时的情绪，一两个词，没有就空。key：只在这件事是会变化的状态时填"对象.方面"（如"ta.作息""ta.数学成绩"），不要写具体值，拿不准就空。followUp：ta 说过的、之后会有结果、值得过后问一句的事，写清时间（如"周五的数学月考成绩"）；伙伴自己的追问、ta 没回应的话、小事不算，大多数时候为空。',
  'traits：这段聊天里能看出的 ta 的性格、习惯、偏好、喜欢被怎样对待，0 到 3 条。key 是"方面"（如"说话方式""压力来时""作息"），同一方面以后要用同一个 key；text 一句话；evidence 写这次聊天里的依据。没有依据就不要写，不要猜。',
  'mood：ta 在这段聊天结束时的整体状态，valence -1（很低落）到 1（很开心）；看不出就 null。',
  'retract：ta 明确要求忘掉、别记的事的关键词；没有就空数组。',
  '只依据聊天内容，不要编造。伙伴自己说的话不能当成 ta 的特点的证据；伙伴随口编的、聊天之外的经历（"我上次路过食堂"）不要写进往事。',
  '如果说明这是群聊：往事写成"在群里……"，可以提到当时在场的成员；只有 ta（用户）自己的话才算 ta 的性格和情绪的证据，其他成员的话不算。',
].join('\n');

/** The transcript a digest reads: who said what, the user's lines kept longest. */
export function transcript(lines, { botName = '我', max = 6_000 } = {}) {
  const out = [];
  let left = max;
  for (const line of [...lines].reverse()) {
    const who = line.role === 'user' ? 'ta' : line.role === 'other' ? line.who : botName === '我' ? '我' : `我（${botName}）`;
    const text = cut(line.text.replace(/\s+/g, ' ').trim(), line.role === 'user' ? 800 : 400);
    if (!text) continue;
    const entry = `${who}：${text}`;
    if ([...entry].length > left) break;
    out.unshift(entry);
    left -= [...entry].length;
  }
  return out.join('\n');
}

const num = (v, d) => (Number.isFinite(Number(v)) ? clamp01(Number(v)) : d);
const str = (v, max) => (typeof v === 'string' ? cut(v.replace(/\s+/g, ' ').trim(), max) : '');

/** The digest's answer, checked and trimmed; nothing usable is an empty digest. */
export function parseDigest(text) {
  const empty = { episodes: [], traits: [], mood: null, retract: [] };
  let value;
  const raw = String(text ?? '').trim();
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try { value = JSON.parse(candidate); break; } catch { /* next */ }
  }
  if (!value || typeof value !== 'object') return empty;
  const episodes = (Array.isArray(value.episodes) ? value.episodes : []).slice(0, EPISODE.perDigest)
    .map((e) => ({
      text: str(e?.text, 300),
      cues: (Array.isArray(e?.cues) ? e.cues : []).map((c) => str(c, 20)).filter(Boolean).slice(0, 6),
      importance: num(e?.importance, 0.5),
      emotion: num(e?.emotion, 0.3),
      mood: str(e?.mood, 12),
      key: /^[^\s]{1,20}\.[^\s]{1,20}$/u.test(str(e?.key, 40)) && !/\d/.test(e.key) ? str(e.key, 40) : '',
      followUp: str(e?.followUp, 80),
    }))
    .filter((e) => [...e.text].length >= 10);
  const traits = (Array.isArray(value.traits) ? value.traits : []).slice(0, 3)
    .map((t) => ({ key: str(t?.key, 20), text: str(t?.text, TRAIT.chars), evidence: str(t?.evidence, 120) }))
    .filter((t) => t.key && t.text && t.evidence);
  const m = value.mood;
  const mood = m && typeof m === 'object' && str(m.word, 12)
    ? { word: str(m.word, 12), valence: Number.isFinite(Number(m.valence)) ? Math.max(-1, Math.min(1, Number(m.valence))) : 0 }
    : null;
  const retract = (Array.isArray(value.retract) ? value.retract : []).map((r) => str(r, 20)).filter((r) => [...r].length >= 2).slice(0, 5);
  return { episodes, traits, mood, retract };
}

// Speaking first.

export const REACH = {
  /** Local hours when the companion never writes (start inclusive, end exclusive). */
  quietStart: 23,
  quietEnd: 8,
  /** Hours after the last conversation before a reach, and the window it falls in. */
  minHoursAfterTalk: 6,
  windowHours: 18,
  /** A delivered reach unanswered for this long counts as ignored. */
  answerHours: 12,
  /** Delivered this long after its time, it is stale and dropped. */
  staleHours: 18,
  baseChance: 0.45,
};

const inQuiet = (ms, tzOffset, start, end) => {
  if (start === end) return false;
  const hour = new Date(ms + tzOffset * 60_000).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

/**
 * When to speak first, or why not. `random` is 0–1 (two draws). The chance grows with the days
 * since the last reach; two ignored in a row push the next one three days out, four stop it
 * until the user talks again (which clears the count).
 * @returns {{ fireAt:number } | { skip:string }}
 */
export function planReach({ now, tzOffset = 0, lastUserAt, lastReachAt, ignored = 0, quietStart = REACH.quietStart, quietEnd = REACH.quietEnd, random = Math.random }) {
  if (ignored >= 4) return { skip: 'ignored' };
  if (!lastUserAt) return { skip: 'never-talked' };
  const sinceReachDays = lastReachAt ? (now - lastReachAt) / DAY_MS : 30;
  const chance = Math.min(0.9, REACH.baseChance + 0.15 * Math.max(0, sinceReachDays - 1));
  if (random() >= chance) return { skip: 'dice' };
  let earliest = Math.max(now + 2 * 3_600_000, lastUserAt + REACH.minHoursAfterTalk * 3_600_000);
  if (ignored >= 2) earliest += 3 * DAY_MS;
  let at = earliest + random() * REACH.windowHours * 3_600_000;
  // Out of quiet hours: to their end, plus up to two hours, as a person waking up.
  for (let i = 0; i < 24 && inQuiet(at, tzOffset, quietStart, quietEnd); i += 1) at += 3_600_000;
  if (inQuiet(at, tzOffset, quietStart, quietEnd)) return { skip: 'quiet' };
  // One a local day.
  if (lastReachAt && dayStart(lastReachAt, tzOffset) === dayStart(at, tzOffset)) at += DAY_MS;
  return { fireAt: Math.round(at) };
}

export const OPENER_SYSTEM = [
  '你要以下面这个角色的身份，主动给一个很熟的人发一条消息。只输出这条消息本身；如果现在没有自然的理由找 ta，只输出 SKIP。',
  '要求：一两句，不超过 40 字，像朋友随手发的；可以接着之前没聊完的事、关心一下 ta 当时提到的事、或者就是一个小念头。只说一件事、最多问一个问题；优先接最近一次聊的事（标着「最近一次」的那条），尤其是开心或难过的事。',
  '不要："在吗"、客服腔、一次问好几个问题、说你在想念 ta 或你记得什么、提到你是 AI、提到通知或系统、表情包堆砌。',
].join('\n');

/** What the opener writer is told: who the companion is, what it knows, when it is, and where (a group: `room`). */
export function openerPrompt({ botName, persona, traits = [], episodes = [], fireAt, tzOffset = 0, now, room }) {
  const local = new Date(fireAt + tzOffset * 60_000);
  const weekday = '日一二三四五六'[local.getUTCDay()];
  const time = `星期${weekday} ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  return [
    `你是「${botName}」。${persona ? `你的设定：${cut(persona, 600)}` : ''}`,
    traits.length ? `你对 ta 的了解：\n${traits.map((t) => `- ${t.text}`).join('\n')}` : '',
    episodes.length ? `你们最近的事（新的在前）：\n${episodes.map((e, i) => `- ${i === 0 ? '【最近一次】' : ''}${whenSaid(e.happenedAt, now, tzOffset)}：${cut(e.text, 120)}${e.followUp ? `（还没结果：${e.followUp}）` : ''}`).join('\n')}` : '',
    room
      ? `消息会在 ${time} 发在群聊「${room.name}」里（你是群主，群里还有 ${room.members.join('、') || '别的 Bot'} 和 ta）。只用群里的事开头，不提 ta 私下说过的事；可以是招呼大家的一句。${room.learning ? '群里开着学习模式，可以自然地提一句学习，但不要出题。' : ''}`
      : `消息会在 ${time} 发出。`,
  ].filter(Boolean).join('\n\n');
}

/** The opener as sent, or '' for SKIP or anything unusable. */
export function parseOpener(text) {
  const line = String(text ?? '').trim().replace(/^["「『]|["」』]$/g, '').split('\n')[0].trim();
  if (!line || /^skip$/i.test(line) || /^在吗[？?]?$/.test(line)) return '';
  return cut(line, 60);
}

/** The turn that delivers a reach: the companion says what it sent, as its own words. */
export function reachText({ text, fireAt, tzOffset = 0 }) {
  const local = new Date(fireAt + tzOffset * 60_000);
  const hm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  return `[Firefly 伙伴 · 主动开口]\n你在 ${hm} 主动给 ta 发了一条消息：「${text}」\n现在把这句话作为你这一轮说的话发出来（原样，或者顺一点、补半句也行）。不要解释为什么发，不要提通知、系统或这条说明。`;
}

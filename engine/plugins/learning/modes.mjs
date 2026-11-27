// The three learning modes and what a learning session's turn is told.
//
// A mode is a skill that ships with the app (engine/skills/learning-<mode>/SKILL.md, the
// bundled root DSH already loads), so the same instructions are there as `/learning-...` in
// any session. A session the app started in a mode (store: session_modes) also gets them
// without asking: at the first step of each turn, `turnNote` builds one note for the model,
// recorded the way ios-call records its call note (a user message of its own source kind,
// which the app's timeline does not show). It holds
//   - the mode's instructions in full the first time the session sees that mode, and a
//     one-line reminder on later turns, so a long session does not repeat them every turn;
//   - a few learning memories picked for this turn (`pickMemories`), unless the user turned
//     that off in Settings → Learning.
// Sessions with no mode get nothing: ordinary DSH sessions behave as they did.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { parseSkill } from './skills.mjs';

/** mode id → the bundled skill that holds its instructions. */
export const MODES = {
  qa: { skill: 'learning-qa', title: 'Ask' },
  socratic: { skill: 'learning-socratic', title: 'Guide' },
  quiz: { skill: 'learning-quiz', title: 'Quiz' },
};
export const MODE_IDS = Object.keys(MODES);

/** The note's source kind; the app's timeline shows only `user` messages. */
export const SOURCE = 'learning-context';

/**
 * How much memory one turn gets. At most `count` memories, each cut to `each` characters,
 * all of them together at most `total` characters (counted in code points, memory text
 * only). A piece shorter than `minPiece` is not worth sending and is left out.
 */
export const MEMORY_BUDGET = { count: 3, each: 300, total: 800, minPiece: 40 };

/** The bundled skill root: engine/skills, beside engine/plugins. */
export const BUNDLED_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** A mode's instructions: the body of its SKILL.md. */
export function modeInstructions(mode, dir = BUNDLED_SKILLS) {
  const spec = MODES[mode];
  if (!spec) throw new Error(`unknown learning mode ${mode}`);
  const parsed = parseSkill(fs.readFileSync(path.join(dir, spec.skill, 'SKILL.md'), 'utf8'));
  if (!parsed?.body.trim()) throw new Error(`${spec.skill}/SKILL.md has no instructions`);
  return parsed.body.trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * What relevance is measured on: words of two or more letters or digits outside CJK, and
 * every pair of neighbouring CJK characters (Chinese has no spaces, and most words are
 * two characters long). Lower-cased, as a set.
 */
export function relevanceTokens(text) {
  const tokens = new Set();
  for (const run of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...run];
    let latin = '';
    const flush = () => { if ([...latin].length >= 2) tokens.add(latin); latin = ''; };
    for (let i = 0; i < chars.length; i += 1) {
      if (CJK.test(chars[i])) {
        flush();
        if (i + 1 < chars.length && CJK.test(chars[i + 1])) tokens.add(chars[i] + chars[i + 1]);
      } else {
        latin += chars[i];
      }
    }
    flush();
  }
  return tokens;
}

/** How much of `query`'s tokens `memory` shares: shared tokens over √(memory tokens). */
export function relevance(queryTokens, memory) {
  const own = relevanceTokens(memory);
  if (!own.size || !queryTokens.size) return 0;
  let shared = 0;
  for (const token of own) if (queryTokens.has(token)) shared += 1;
  return shared / Math.sqrt(own.size);
}

/** `text` cut to `max` code points, marked with an ellipsis when cut. */
export function cut(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * The memories one turn gets, best first: those that share words with what the user just
 * wrote, by relevance (newest first on a tie); when fewer than `budget.count` do, the most
 * recently updated of the rest fill one more place, so standing facts ("I am preparing
 * for the maths exam") still reach turns that do not repeat their words.
 * @param {{id:number, content:string, updatedAt:number}[]} memories
 * @param {string} userText
 * @returns {{id:number, text:string, cut:boolean}[]}
 */
export function pickMemories(memories, userText, budget = MEMORY_BUDGET) {
  const query = relevanceTokens(userText);
  const scored = memories
    .map((memory) => ({ memory, score: relevance(query, memory.content) }))
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || b.memory.id - a.memory.id);
  const chosen = scored.filter((entry) => entry.score > 0).slice(0, budget.count);
  if (chosen.length < budget.count) {
    const rest = scored.filter((entry) => entry.score === 0)
      .sort((a, b) => b.memory.updatedAt - a.memory.updatedAt || b.memory.id - a.memory.id);
    if (rest.length) chosen.push(rest[0]);
  }
  const picked = [];
  let left = budget.total;
  for (const { memory } of chosen) {
    const room = Math.min(budget.each, left);
    if (room < budget.minPiece) break;
    const text = cut(memory.content.replace(/\s+/g, ' ').trim(), room);
    picked.push({ id: memory.id, text, cut: text !== memory.content.replace(/\s+/g, ' ').trim() });
    left -= [...text].length;
  }
  return picked;
}

/** The text of what the user wrote in this step's new messages (their own messages only). */
export function userTextOf(messages) {
  return messages
    .filter((message) => message?.role === 'user' && (message.source?.kind ?? 'user') === 'user')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The note's sections. `announce` puts the mode's instructions in full; otherwise a
 * reminder. Memories, when given, follow under their own heading.
 * @returns {{name:string, text:string}[]}
 */
export function noteSections({ mode, announce, instructions, memories = [] }) {
  const spec = MODES[mode];
  const sections = [];
  if (announce) {
    sections.push({
      name: 'learning-mode',
      text: `This is a learning session in the mode "${spec.title}" (skill ${spec.skill}). Follow these instructions `
        + `for the rest of the session, until the user changes the mode; any learning mode given earlier in this `
        + `session no longer applies:\n\n${instructions}`,
    });
  } else {
    sections.push({
      name: 'learning-mode',
      text: `Learning mode "${spec.title}": keep following the ${spec.skill} instructions given earlier in this `
        + `session. If you no longer have them, load the skill ${spec.skill}.`,
    });
  }
  if (memories.length) {
    sections.push({
      name: 'learning-memory',
      text: 'What you know about this learner (from their learning memory, which they can see and edit in '
        + 'Settings → Learning; some may not apply to this turn):\n'
        + memories.map((memory) => `- ${memory.text}`).join('\n'),
    });
  }
  return sections;
}

/**
 * The learner's words in a turn: their own messages, or, in a Bot team, the relays that
 * carry them (a group round shows the user's lines among the members'). The relay's first
 * line, ds-bot's header ("[Group chat …]"), is left out.
 */
export function learnerTextOf(messages) {
  const own = userTextOf(messages);
  if (own) return own;
  return messages
    .filter((message) => message?.role === 'user' && message.source?.kind === 'bot' && message.source?.form === 'relay')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.replace(/^\[[^\]\n]*\]\n?/, ''))
    .join('\n');
}

/** Extra for a Bot's own chat: the Bot stays itself. */
export function botSections() {
  return [{
    name: 'learning-bot',
    text: 'You keep your own character, voice and memory; follow the learning mode in your own way.',
  }];
}

/**
 * Extra for the group's admin, who teaches in learning mode. `members`: the other
 * members' names.
 */
export function teacherSections({ roomName, members }) {
  const others = members.length ? members.join(', ') : 'no one else yet';
  return [{
    name: 'learning-teacher',
    text: `In the group chat "${roomName}" you, as its admin, are the teacher while learning mode is on. `
      + `The other members (${others}) only add to what you say; you alone set quiz questions. When a member can help, `
      + 'call on them, and you may pass on the one or two things about the learner that matter for it, in your own words; '
      + 'never the whole list.',
  }];
}

/** The note for a group member who is not the teacher: full when announcing, else one line. */
export function memberSections({ mode, announce, roomName, teacher }) {
  const spec = MODES[mode];
  if (!announce) {
    return [{ name: 'learning-member', text: `Learning mode "${spec.title}" in "${roomName}": ${teacher} leads; add, don't answer for the learner, set no questions, or pass.` }];
  }
  return [{
    name: 'learning-member',
    text: `The group chat "${roomName}" is in learning mode "${spec.title}". Its admin, ${teacher}, leads it as the teacher. `
      + `You may add to what ${teacher} says, encourage the learner, or point out something missing. Do not give the answer `
      + `outright, and do not set questions of your own: only ${teacher} does. When you have nothing to add, pass.`,
  }];
}

/** The once-only note after the user ended learning mode `mode` in a session. */
export function leftSections(mode) {
  const spec = MODES[mode];
  return [{
    name: 'learning-mode',
    text: `The user ended learning mode${spec ? ` "${spec.title}"` : ''} for this session. From this turn on, answer as in `
      + 'an ordinary conversation: do not keep quizzing, do not hold back answers or ask one guiding question at a time, '
      + 'unless the user asks for that again.',
  }];
}

/** The note as one message of its own source kind. */
export function noteMessage(sections) {
  const text = sections.map((section) => section.text).join('\n\n');
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE, form: 'snapshot', sections },
  });
}

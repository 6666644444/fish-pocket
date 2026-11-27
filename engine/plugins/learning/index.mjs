// Learning: the app's notebooks and the learner's long-term memory (store.mjs), the
// learning modes (modes.mjs) and the user's own skills (skills.mjs), offered to the app's
// own screens as JSON routes beside the engine's, the way the other iOS plugins offer
// theirs (ios-voice-message, ios-speech):
//
//   POST /api/learning/<method>   body: the method's parameters as a JSON object
//     → 200 { ok: true, result }
//     → 400 / 404 / 409 / 503 { error: { kind, message } }
//
// Methods (METHODS below): notebooks.list|get|create|update|delete,
// notes.list|get|create|update|delete|search, memories.list|get|create|update|delete|clear,
// status, and from M2 settings.get|update, modes.list, sessions.getMode|setMode|list,
// skills.list|get|create|update|delete, and from M3 kb.status, kb.documents.list|get|import|delete,
// kb.chunks.get, kb.vectors.pending|put|clear, kb.search and kb.parse.cloud (not implemented).
//
// A session the app put in a learning mode gets, at the first step of each turn, one note
// with the mode's instructions and a few learning memories (modes.mjs). Other sessions are
// left exactly as they were. A failure there never stops the turn: the turn goes on without
// the note.
//
// The library opens on the first request (or the first step of a turn), not at start-up,
// so an engine start never waits on it or fails because of it; it closes when the plugin
// is disposed.
import { LearningError, LearningStore, libraryFile, SCHEMA_VERSION } from './store.mjs';
import { MODES, MODE_IDS, botSections, learnerTextOf, leftSections, memberSections, modeInstructions, noteMessage, noteSections, pickMemories, teacherSections, userTextOf } from './modes.mjs';
import { TeamIndex, learningOwner, learningTurn, ownerKey, teamFile } from './dsbot.mjs';
import { SkillFiles, skillsDir } from './skills.mjs';
import { appleEmbedder, appleQueryVectors, embedPending } from './embed.mjs';
import { quizTool } from './quiz-tool.mjs';
import { ResearchRunner, backgroundOnly, researchTool } from './research-tool.mjs';
import {
  BEFORE_RESTORE, backupLibrary, deleteBackup, deleteLearningData, exportLibrary, importExport, importLibrary, listBackups, restoreLibrary,
} from './portable.mjs';
import path from 'node:path';

/** A backup as the app sees it: no engine path. */
const publicBackup = ({ name, bytes, createdAt, kind }) => ({ name, bytes, createdAt, kind });

/** What the library holds, for the deletion dialog. */
function summary(store) {
  const count = (table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return {
    notebooks: count('notebooks'), notes: count('notes'), memories: count('memories'), documents: count('kb_documents'),
    questions: count('quiz_questions'), mistakes: count('quiz_mistakes'), research: count('research_jobs'),
  };
}

export const ROUTE = '/api/learning';

/** method → what it does with the library (`store`), the skill folder (`skills`) and the parameters. */
export const METHODS = {
  status: ({ store }) => ({ schemaVersion: store.version, latestSchemaVersion: SCHEMA_VERSION, search: store.fts }),
  'notebooks.list': ({ store }) => store.listNotebooks(),
  'notebooks.get': ({ store }, p) => store.getNotebook(p.id),
  'notebooks.create': ({ store }, p) => store.createNotebook(p),
  'notebooks.update': ({ store }, p) => store.updateNotebook(p),
  'notebooks.delete': ({ store }, p) => store.deleteNotebook(p),
  'notes.list': ({ store }, p) => store.listNotes(p),
  'notes.get': ({ store }, p) => store.getNote(p),
  'notes.create': ({ store }, p) => store.createNote(p),
  'notes.update': ({ store }, p) => store.updateNote(p),
  'notes.delete': ({ store }, p) => store.deleteNote(p),
  'notes.search': ({ store }, p) => store.searchNotes(p),
  'memories.list': ({ store }, p) => store.listMemories(p),
  'memories.get': ({ store }, p) => store.getMemory(p),
  'memories.create': ({ store }, p) => store.createMemory(p),
  'memories.update': ({ store }, p) => store.updateMemory(p),
  'memories.delete': ({ store }, p) => store.deleteMemory(p),
  'memories.clear': ({ store }) => store.clearMemories(),
  'settings.get': ({ store }) => store.getSettings(),
  'settings.update': ({ store, index }, p) => {
    const settings = store.updateSettings(p);
    if (p.appleEmbedding === true) index();
    return settings;
  },
  'modes.list': () => MODE_IDS.map((id) => ({ id, skill: MODES[id].skill })),
  'sessions.getMode': ({ store }, p) => store.getSessionMode(p),
  'sessions.setMode': ({ store }, p) => store.setSessionMode(p),
  'sessions.list': ({ store }, p) => store.listSessionModes(p),
  // The learning record: sessions whose mode was ended (学习记录), and taking one off it.
  'sessions.history': ({ store }, p) => store.listLearningHistory(p),
  'sessions.hide': ({ store }, p) => store.hideLearningHistory(p),
  // Learning modes of Bots and group chats (dsbot.mjs): `kind` 'bot' or 'room', `id` the
  // Bot's or the group's id. A group needs an admin: the admin teaches.
  'owners.get': ({ store, team }, p) => ownerStatus(store, team, p, store.getOwnerMode(p)),
  'owners.set': ({ store, team }, p) => {
    if (p?.kind === 'room' && p?.mode !== null && !team?.room(String(p?.id ?? ''))?.admin) {
      throw new LearningError('conflict', 'the group has no admin; set one in the group\'s details first');
    }
    return ownerStatus(store, team, p, store.setOwnerMode(p));
  },
  'owners.list': ({ store, team }) => store.listOwnerModes().map((o) => ownerStatus(store, team, o, o)),
  'owners.history': ({ store, team }) => store.listOwnerHistory().map((o) => ownerStatus(store, team, o, o)),
  'owners.hide': ({ store }, p) => store.hideOwnerHistory(p),
  'skills.list': ({ skills }) => skills().list(),
  'skills.get': ({ skills }, p) => skills().get(p),
  'skills.create': ({ skills }, p) => skills().create(p),
  'skills.update': ({ skills }, p) => skills().update(p),
  'skills.delete': ({ skills }, p) => skills().delete(p),
  // M3: the light knowledge base. Vectors come from the app (NLEmbedding or an OpenAI-compatible
  // provider whose key stays in the Keychain); the engine stores and compares them.
  'kb.status': ({ store, embedder }) => ({
    search: store.kbFts,
    vectors: store.vectorStatus(),
    appleEmbedding: { available: Boolean(embedder), enabled: store.getSettings().appleEmbedding },
  }),
  'kb.documents.list': ({ store }) => store.listDocuments(),
  'kb.documents.get': ({ store }, p) => store.getDocument(p),
  'kb.documents.import': ({ store, index }, p) => {
    const document = store.importDocument(p);
    index();
    return document;
  },
  'kb.documents.delete': ({ store }, p) => store.deleteDocument(p),
  'kb.chunks.get': ({ store }, p) => store.getChunk(p),
  'kb.vectors.pending': ({ store }, p) => store.pendingVectors(p),
  'kb.vectors.put': ({ store }, p) => store.putVectors(p),
  'kb.vectors.clear': ({ store }, p) => store.clearVectors(p),
  // Embeds any chunk still lacking an Apple vector; answers at once, the work runs on.
  'kb.vectors.index': ({ embedder, index }) => ({ started: Boolean(embedder && index()) }),
  // With Apple's embedding on, the query is embedded for each Apple model that has vectors
  // and searched beside the keyword ranking; vectors the app sends (`queryVectors`, from an
  // OpenAI-compatible provider) join in. Without it, keyword search only.
  'kb.search': async ({ store, embedder }, p) => {
    let extra = [];
    if (embedder && store.getSettings().appleEmbedding && typeof p.query === 'string' && p.query.trim()) {
      try { extra = await appleQueryVectors(store, embedder, p.query); } catch { extra = []; }
    }
    const queryVectors = [...(Array.isArray(p.queryVectors) ? p.queryVectors : []), ...extra];
    return store.searchKnowledge({ ...p, queryVectors: queryVectors.length ? queryVectors : undefined });
  },
  // Scanned PDFs need OCR. The interface is defined (the app sends the PDF's bytes as base64
  // with a file name); no cloud parser is built, so it always answers `unsupported`.
  'kb.parse.cloud': () => {
    throw new LearningError('unsupported', 'reading scanned PDFs needs a cloud parser, which is not implemented');
  },
  // M4: the question bank and the mistake book. The model saves and grades through the
  // learning_quiz tool; the app lists, redoes and deletes through these routes.
  'quiz.questions.list': ({ store }, p) => store.listQuestions(p),
  'quiz.questions.get': ({ store }, p) => store.getQuestion({ id: p.id, withAnswer: p.withAnswer !== false }),
  'quiz.questions.create': ({ store }, p) => store.saveQuestions({ questions: p.questions, source: 'user' }),
  'quiz.questions.delete': ({ store }, p) => store.deleteQuestion(p),
  'quiz.topics': ({ store }) => store.quizTopics(),
  'quiz.answer': ({ store }, p) => store.answerQuestion(p),
  'quiz.attempts': ({ store }, p) => store.listAttempts(p),
  // M5: research jobs. The model starts them with the deep_research tool; the app lists them,
  // reads reports, resumes a paused job (with the model it started with) and cancels.
  'research.list': ({ store }, p) => store.listResearchJobs(p),
  'research.get': ({ store }, p) => store.getResearchJob({ id: p.id }),
  'research.claims': ({ store }, p) => store.listClaims({ jobId: store.getResearchJob({ id: p.id, withReport: false }).id }),
  'research.resume': ({ store, runner }, p) => ({ ...runner.start(store.getResearchJob({ id: p.id, withReport: false }).id), job: store.getResearchJob({ id: p.id, withReport: false }) }),
  'research.cancel': ({ runner }, p) => runner.cancel(p.id),
  'research.delete': ({ store, runner }, p) => {
    if (runner.running.has(p.id)) throw new LearningError('conflict', 'cancel the research before deleting it');
    return store.deleteResearchJob(p);
  },
  // M6: export, import, backup, restore and deleting all learning data. Only `$DSH_HOME/learning`
  // is touched (portable.mjs).
  'data.summary': ({ store }) => summary(store),
  'data.export': ({ portable }, p) => portable.export(p),
  'data.import': ({ portable }, p) => portable.import(p),
  // `local`: the phone's time as YYYY-MM-DD-HH-mm-ss, for the file name (portable.mjs stamp).
  'backup.create': ({ portable }, p) => portable.backup(p),
  'backup.list': ({ portable }) => portable.listBackups(),
  'backup.restore': ({ portable }, p) => portable.restore(p),
  'backup.delete': ({ portable }, p) => portable.deleteBackup(p),
  'data.delete': ({ portable }, p) => portable.deleteAll(p),
};

const STATUS = { invalid: 400, 'not-found': 404, conflict: 409, unsupported: 422, unavailable: 503 };

/** A Bot's or a group's learning mode as the app shows it: with names, the teacher, and whether it is paused. */
function ownerStatus(store, team, ref, record) {
  const kind = String(ref?.kind ?? '');
  const id = String(ref?.id ?? '');
  const out = { kind, id, mode: record?.mode ?? null, updatedAt: record?.updatedAt ?? null, endedAt: record?.endedAt ?? null };
  if (kind === 'bot') {
    const bot = team?.bot(id);
    if (bot) out.name = bot.name;
  } else if (kind === 'room') {
    const room = team?.room(id);
    if (room) {
      out.name = room.name;
      if (room.admin) out.teacher = { id: room.admin, name: team.bot(room.admin)?.name ?? room.admin };
      out.paused = out.mode !== null && !room.admin;
    }
  }
  return out;
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/**
 * Answer one call: what the route sends back for `method` with `params`. A Response, or a
 * promise of one for the methods that wait on something (kb.search embeds the query).
 * @param {() => LearningStore} open - the library, opened on first use.
 * @param {string} method
 * @param {object} params
 * @param {() => SkillFiles} [skills] - the skill folder.
 * @param {{ embedder?: object|null, index?: () => unknown }} [kb] - Apple's embedding and the indexer.
 */
export function call(open, method, params, skills = () => new SkillFiles(skillsDir()), kb = {}) {
  const run = METHODS[method];
  if (!run) return json({ error: { kind: 'invalid', message: `unknown method ${method}` } }, 404);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return json({ error: { kind: 'invalid', message: 'the body must be a JSON object' } }, 400);
  }
  const fail = (error) => {
    if (error instanceof LearningError) {
      return json({ error: { kind: error.kind, message: error.message } }, STATUS[error.kind] ?? 400);
    }
    return json({ error: { kind: 'internal', message: String(error?.message ?? error) } }, 500);
  };
  const done = (value) => json({ ok: true, result: value ?? null });
  try {
    const where = { skills, embedder: kb.embedder ?? null, index: kb.index ?? (() => null), runner: kb.runner, portable: kb.portable, team: kb.team };
    Object.defineProperty(where, 'store', { get: open });
    const value = run(where, params);
    return value && typeof value.then === 'function' ? value.then(done, fail) : done(value);
  } catch (error) {
    return fail(error);
  }
}

/**
 * A note about research this conversation left paused (the app was closed mid-run), once per
 * job and engine run: the model resumes it instead of starting over, and tells the learner
 * where it can be continued. Undefined when there is nothing to say.
 * @param {LearningStore} store
 * @param {string} sessionId
 * @param {{ running: Map<number, unknown>, told: Set<number> }} state
 */
export function pausedResearchNote(store, sessionId, { running, told, keyOf = (id) => id }) {
  const key = keyOf(sessionId);
  const paused = store.listResearchJobs({ limit: 50 })
    .filter((j) => j.sessionId && keyOf(j.sessionId) === key && j.status === 'paused' && !running.has(j.id) && !told.has(j.id));
  if (!paused.length) return undefined;
  for (const j of paused) told.add(j.id);
  const lines = paused.map((j) => `- research #${j.id} "${j.topic}": ${j.blocksDone}/${j.blocks} parts done`);
  return noteMessage([{
    name: 'learning-research',
    text: 'Deep research in this conversation was paused when the app was closed:\n'
      + `${lines.join('\n')}\n`
      + 'If the user wants to go on with it, call deep_research with action "resume" and that id: it continues from where '
      + 'it stopped, keeping finished parts. Do not start a new research on the same question. If the user has not '
      + 'brought it up, mention it briefly once: it can also be continued in the app under 设置 → 学习 → 深度研究.',
  }]);
}

/**
 * The note for one turn of `sessionId`, or undefined when there is nothing to say. A plain
 * conversation keeps its own mode; a Bot's chat and a group member's Session follow the
 * Bot's or the group's (dsbot.mjs); a group's own Session gets nothing.
 * @param {LearningStore} store
 * @param {string} sessionId
 * @param {readonly object[]} messages - the step's new messages.
 * @param {{ skillDir?: string, team?: import('./dsbot.mjs').TeamIndex }} [options]
 */
export function turnNote(store, sessionId, messages, options = {}) {
  const owner = learningOwner(options.team, sessionId);
  if (owner.kind === 'relay') return undefined;
  if (owner.kind !== 'session') return ownerNote(store, owner, sessionId, messages, options);
  const session = store.getSessionMode({ sessionId });
  if (!session) {
    // Out of learning just now: say so once, or the model keeps to the mode it was given.
    const left = store.takeLeftMode({ sessionId });
    return left ? noteMessage(leftSections(left)) : undefined;
  }
  const announce = session.announced !== session.mode;
  const instructions = announce ? modeInstructions(session.mode, options.skillDir) : undefined;
  const memories = store.getSettings().injectMemories
    ? pickMemories(store.recentMemories(), userTextOf(messages))
    : [];
  const message = noteMessage(noteSections({ mode: session.mode, announce, instructions, memories }));
  if (announce) store.markAnnounced({ sessionId, mode: session.mode });
  return message;
}

/**
 * The note for a Bot's chat or a group member's Session. The full note is given once per
 * Session and role (a Bot's fresh part, a member new to the group, a new admin get it again);
 * an ended mode is told once to each Session that had it. A group without an admin is paused.
 */
function ownerNote(store, owner, sessionId, messages, { skillDir, team }) {
  const record = store.ownerRecord(owner);
  if (!record) return undefined;
  const seen = store.ownerSession({ ...owner, sessionId });
  if (record.endedAt !== null) {
    if (!seen?.announced || seen.toldEndAt === record.endedAt) return undefined;
    store.markOwnerSession({ ...owner, sessionId, announced: null, toldEndAt: record.endedAt });
    return noteMessage(leftSections(record.mode));
  }
  let role = 'bot';
  let room;
  if (owner.kind === 'room') {
    room = team?.room(owner.id);
    if (!room?.admin) return undefined;
    role = owner.botId === room.admin ? 'teacher' : 'member';
  }
  const tag = `${record.mode}:${role}`;
  const announce = seen?.announced !== tag;
  let sections;
  if (role === 'member') {
    sections = memberSections({ mode: record.mode, announce, roomName: room.name, teacher: team.bot(room.admin)?.name ?? room.admin });
  } else {
    const instructions = announce ? modeInstructions(record.mode, skillDir) : undefined;
    const memories = store.getSettings().injectMemories ? pickMemories(store.recentMemories(), learnerTextOf(messages)) : [];
    sections = noteSections({ mode: record.mode, announce, instructions, memories });
    if (announce) {
      sections = role === 'teacher'
        ? [...sections, ...teacherSections({ roomName: room.name, members: room.members.filter((id) => id !== room.admin).map((id) => team.bot(id)?.name ?? id) })]
        : [...sections, ...botSections()];
    }
  }
  const message = noteMessage(sections);
  if (announce) store.markOwnerSession({ ...owner, sessionId, announced: tag, toldEndAt: seen?.toldEndAt ?? null });
  return message;
}

/**
 * Whether `sessionId` is learning now with the quiz tool: a plain learning session, a Bot in
 * a learning mode, or the admin of a group in one.
 */
export function quizAllowed(store, team, sessionId) {
  const owner = learningOwner(team, sessionId);
  if (owner.kind === 'session') return store.getSessionMode({ sessionId }) !== null;
  if (owner.kind === 'bot') return store.getOwnerMode(owner) !== null;
  if (owner.kind === 'room') return store.getOwnerMode(owner) !== null && team.room(owner.id)?.admin === owner.botId;
  return false;
}

export default class Learning {
  static inject = ['connection', 'agents', 'tools'];

  /**
   * @param {object} ctx
   * @param {{ file?: string, storeOptions?: object, skillsDir?: string, skillDir?: string }} [config]
   *   tests point `file` (the library), `skillsDir` (the user's skills) and `skillDir`
   *   (the bundled mode skills) elsewhere.
   */
  constructor(ctx, config = {}) {
    let store;
    const open = () => {
      if (!store) {
        store = new LearningStore(config.file ?? libraryFile(), config.storeOptions);
        // Nothing runs before this plugin starts: research left `running` by a stopped engine is paused.
        try { store.pauseInterruptedResearch(); } catch { /* an older library without research tables cannot be here */ }
      }
      return store;
    };
    const skills = () => new SkillFiles(config.skillsDir ?? skillsDir());
    // Apple's embedding (null off iOS, or when a test passes `embedder: null`). Indexing runs
    // in the background, one run at a time, and stops when the plugin is disposed.
    const embedder = config.embedder !== undefined ? config.embedder : appleEmbedder();
    let stop = new AbortController();
    let indexing = null;
    const index = () => {
      if (!embedder || stop.signal.aborted) return null;
      if (indexing) return indexing;
      let library;
      try {
        library = open();
        if (!library.getSettings().appleEmbedding) return null;
      } catch {
        return null;
      }
      indexing = embedPending(library, embedder, { signal: stop.signal })
        .catch((error) => { if (!stop.signal.aborted) ctx.logger?.warn?.(`learning: indexing stopped: ${error?.message ?? error}`); })
        .finally(() => { indexing = null; });
      return indexing;
    };
    this.indexing = () => indexing;
    const service = (name) => {
      if (config.services && name in config.services) return config.services[name];
      try { return ctx.get?.(name); } catch { return undefined; }
    };
    const runner = new ResearchRunner({ open, get: service, embedder, logger: ctx.logger, ...(config.callModel ? { callModel: config.callModel } : {}) });
    this.research = runner;
    // ds-bot's saved team, read only (dsbot.mjs): which Bot or group a Session belongs to.
    const team = new TeamIndex(() => config.teamFile ?? teamFile(path.dirname(path.dirname(config.file ?? libraryFile()))));
    this.team = team;
    // One research at a time per Bot or group, not per Session (a group runs one per member).
    runner.keyOf = (sessionId) => ownerKey(team, sessionId);
    // M6: the library's own folder, and the operations that close and replace or remove it.
    const libraryPath = () => config.file ?? libraryFile();
    const learningDir = () => path.dirname(libraryPath());
    const busy = () => {
      if (runner.running.size) throw new LearningError('conflict', 'research is running; stop it first');
    };
    const closeLibrary = async () => {
      stop.abort();
      await indexing?.catch(() => {});
      stop = new AbortController();
      store?.close();
      store = undefined;
    };
    let restoring = false;
    const portable = {
      export: (p) => exportLibrary(open(), learningDir(), Date.now(), { local: p?.local }),
      import: (p) => (p?.data !== undefined ? importLibrary(open(), p.data) : importExport(open(), String(p?.path ?? ''))),
      backup: (p) => publicBackup(backupLibrary(open(), learningDir(), Date.now(), { local: p?.local })),
      listBackups: () => listBackups(learningDir()).map(publicBackup),
      deleteBackup: (p) => {
        if (restoring) throw new LearningError('conflict', 'a restore is in progress');
        return deleteBackup(learningDir(), p?.name);
      },
      restore: async (p) => {
        busy();
        if (restoring) throw new LearningError('conflict', 'a restore is in progress');
        const name = String(p?.name ?? '');
        const found = listBackups(learningDir()).find((b) => b.name === name);
        if (!found) throw new LearningError('not-found', `no backup named ${name}`);
        restoring = true;
        try {
          const safety = backupLibrary(open(), learningDir(), Date.now(), { local: p?.local, tag: BEFORE_RESTORE });
          await closeLibrary();
          const result = restoreLibrary(libraryPath(), found.path, () => safety);
          open();
          return result;
        } finally {
          restoring = false;
        }
      },
      deleteAll: async (p) => {
        if (p?.confirm !== 'delete-learning-data') throw new LearningError('invalid', 'confirm must be "delete-learning-data"');
        busy();
        await closeLibrary();
        return deleteLearningData(learningDir());
      },
    };
    const kb = { embedder, index, runner, portable, team };
    for (const method of Object.keys(METHODS)) {
      ctx.effect(() => ctx.connection.fetch.register({
        path: `${ROUTE}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let params;
          try {
            const raw = await request.text();
            params = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            return json({ error: { kind: 'invalid', message: 'the body is not JSON' } }, 400);
          }
          return call(open, method, params, skills, kb);
        },
      }), `learning: ${method}`);
    }

    // M4: the model's way into the question bank, offered only in learning sessions.
    // Sessions whose current turn a background-job notice opened (set at each turn's first step).
    const backgroundTurns = new Set();
    this.backgroundTurns = backgroundTurns;
    if (ctx.tools?.register) {
      const inLearning = ({ agent }) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId || agent?.session?.header?.origin === 'subagent') return false;
        try { return quizAllowed(open(), team, sessionId); } catch { return false; }
      };
      ctx.effect(() => ctx.tools.register(quizTool(open), { when: inLearning }), 'learning: quiz tool');
      // M5: deep research, offered in every main session (not to subagents). A turn opened by a
      // background job's notice alone may not start or resume research (research-tool.mjs).
      ctx.effect(() => ctx.tools.register(researchTool(open, runner, { backgroundTurn: (id) => backgroundTurns.has(id) }), { when: ({ agent }) => agent?.session?.header?.origin !== 'subagent' }), 'learning: research tool');
    }

    // Only a turn's first step, and only one that brings new messages: a retry (no
    // messages) already has the note. Learning trouble never fails the turn.
    const toldPaused = new Set();
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted || step !== 1 || !decision.messages?.length) return decision;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || !sessionId) return decision;
      if (backgroundOnly(decision.messages)) backgroundTurns.add(sessionId); else backgroundTurns.delete(sessionId);
      const notes = [];
      try {
        // Only the learner's own turns (dsbot.mjs learningTurn): not a reminder, a Bot's errand,
        // a kickoff or a profile update.
        const owner = learningOwner(team, sessionId);
        const note = learningTurn(owner.kind, decision.messages)
          ? turnNote(open(), sessionId, decision.messages, { skillDir: config.skillDir, team })
          : undefined;
        if (note) notes.push(note);
      } catch (error) {
        ctx.logger?.warn?.(`learning: no note for this turn: ${error?.message ?? error}`);
      }
      if (agent?.session?.header?.origin !== 'subagent') {
        try {
          const note = pausedResearchNote(open(), sessionId, { running: runner.running, told: toldPaused, keyOf: runner.keyOf });
          if (note) notes.push(note);
        } catch (error) {
          ctx.logger?.warn?.(`learning: no research note for this turn: ${error?.message ?? error}`);
        }
      }
      return notes.length ? { ...decision, messages: [...decision.messages, ...notes] } : decision;
    });

    ctx.effect(() => () => {
      stop.abort();
      void runner.dispose();
      store?.close();
      store = undefined;
    }, 'learning: library');
  }
}

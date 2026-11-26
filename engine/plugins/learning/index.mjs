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
import { MODES, MODE_IDS, modeInstructions, noteMessage, noteSections, pickMemories, userTextOf } from './modes.mjs';
import { SkillFiles, skillsDir } from './skills.mjs';
import { appleEmbedder, appleQueryVectors, embedPending } from './embed.mjs';
import { quizTool } from './quiz-tool.mjs';
import { ResearchRunner, researchTool } from './research-tool.mjs';
import {
  backupLibrary, deleteLearningData, exportLibrary, importExport, importLibrary, listBackups, restoreLibrary,
} from './portable.mjs';
import path from 'node:path';

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
  'data.export': ({ portable }) => portable.export(),
  'data.import': ({ portable }, p) => portable.import(p),
  'backup.create': ({ portable }) => portable.backup(),
  'backup.list': ({ portable }) => portable.listBackups(),
  'backup.restore': ({ portable }, p) => portable.restore(p),
  'data.delete': ({ portable }, p) => portable.deleteAll(p),
};

const STATUS = { invalid: 400, 'not-found': 404, conflict: 409, unsupported: 422, unavailable: 503 };

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
    const where = { skills, embedder: kb.embedder ?? null, index: kb.index ?? (() => null), runner: kb.runner, portable: kb.portable };
    Object.defineProperty(where, 'store', { get: open });
    const value = run(where, params);
    return value && typeof value.then === 'function' ? value.then(done, fail) : done(value);
  } catch (error) {
    return fail(error);
  }
}

/**
 * The note for one turn of `sessionId`, or undefined when the session is not in a learning
 * mode. Marks the mode announced once its instructions are in a note.
 * @param {LearningStore} store
 * @param {string} sessionId
 * @param {readonly object[]} messages - the step's new messages.
 * @param {{ skillDir?: string }} [options]
 */
export function turnNote(store, sessionId, messages, options = {}) {
  const session = store.getSessionMode({ sessionId });
  if (!session) return undefined;
  const announce = session.announced !== session.mode;
  const instructions = announce ? modeInstructions(session.mode, options.skillDir) : undefined;
  const memories = store.getSettings().injectMemories
    ? pickMemories(store.recentMemories(), userTextOf(messages))
    : [];
  const message = noteMessage(noteSections({ mode: session.mode, announce, instructions, memories }));
  if (announce) store.markAnnounced({ sessionId, mode: session.mode });
  return message;
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
    const portable = {
      export: () => exportLibrary(open(), learningDir()),
      import: (p) => (p?.data !== undefined ? importLibrary(open(), p.data) : importExport(open(), String(p?.path ?? ''))),
      backup: () => backupLibrary(open(), learningDir()),
      listBackups: () => listBackups(learningDir()).map(({ name, bytes }) => ({ name, bytes })),
      restore: async (p) => {
        busy();
        const name = String(p?.name ?? '');
        const found = listBackups(learningDir()).find((b) => b.name === name);
        if (!found) throw new LearningError('not-found', `no backup named ${name}`);
        const safety = backupLibrary(open(), learningDir(), Date.now() + 1_000);
        await closeLibrary();
        const result = restoreLibrary(libraryPath(), found.path, () => safety);
        open();
        return result;
      },
      deleteAll: async (p) => {
        if (p?.confirm !== 'delete-learning-data') throw new LearningError('invalid', 'confirm must be "delete-learning-data"');
        busy();
        await closeLibrary();
        return deleteLearningData(learningDir());
      },
    };
    const kb = { embedder, index, runner, portable };
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
    if (ctx.tools?.register) {
      const inLearning = ({ agent }) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId || agent?.session?.header?.origin === 'subagent') return false;
        try { return open().getSessionMode({ sessionId }) !== null; } catch { return false; }
      };
      ctx.effect(() => ctx.tools.register(quizTool(open), { when: inLearning }), 'learning: quiz tool');
      // M5: deep research, offered in every main session (not to subagents).
      ctx.effect(() => ctx.tools.register(researchTool(open, runner), { when: ({ agent }) => agent?.session?.header?.origin !== 'subagent' }), 'learning: research tool');
    }

    // Only a turn's first step, and only one that brings new messages: a retry (no
    // messages) already has the note. Learning trouble never fails the turn.
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted || step !== 1 || !decision.messages?.length) return decision;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || !sessionId) return decision;
      let note;
      try {
        note = turnNote(open(), sessionId, decision.messages, { skillDir: config.skillDir });
      } catch (error) {
        ctx.logger?.warn?.(`learning: no note for this turn: ${error?.message ?? error}`);
        return decision;
      }
      return note ? { ...decision, messages: [...decision.messages, note] } : decision;
    });

    ctx.effect(() => () => {
      stop.abort();
      void runner.dispose();
      store?.close();
      store = undefined;
    }, 'learning: library');
  }
}

// The learning library: notebooks, notes and the learner's long-term memory, in one
// SQLite file of its own (node:sqlite, the same stack as DSH's session search).
//
// Where it lives: `$DSH_HOME/learning/learning.db`, one folder below `$DSH_HOME`. The
// engine's recovery (runtime/recovery.mjs) treats every small file directly in
// `$DSH_HOME` and in `profiles/web` as a setting, checkpoints it at each start, puts it
// back on "restore" and moves it away on "reset". A database there would be rolled back
// or moved away with the settings, so it must stay in a folder of its own.
//
// It never touches what DSH or ds-bot keep (sessions, Bot memory in MEMORY.md): clearing
// the learning memory clears this file's `memories` table and nothing else.
//
// All SQL lives in this file. Callers get plain objects with camelCase fields.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blobToVector, chunkText, citationOf, cosine, fuseRanks, vectorToBlob } from './kb.mjs';
import { DAY_MS, MASTERY, QuizError, dayStart, grade, letter, nextMistake, normalizeQuestion, QUIZ_LIMITS } from './quiz.mjs';

/** `PRAGMA application_id`: 'LRN1'. DSH's session search uses 1146308689; this must differ. */
export const APPLICATION_ID = 0x4c524e31;
/** Limits on what one request may store. */
export const LIMITS = {
  title: 200, body: 1_000_000, memory: 4_000, query: 200, page: 200,
  // M3: one imported document, a model name, a vector, one vectors.put call.
  document: 5_000_000, model: 200, dims: 4_096, vectorBatch: 256,
};

/** The database file under `$DSH_HOME`. */
export function libraryFile(home = process.env.DSH_HOME) {
  if (!home) throw new LearningError('unavailable', 'DSH_HOME is not set');
  return path.join(home, 'learning', 'learning.db');
}

export class LearningError extends Error {
  /** @param {'invalid'|'not-found'|'unavailable'|'conflict'|'unsupported'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The schema, one step per version. A step only adds; it never drops or rewrites what
 * an earlier step made, so every older library opens with its data intact.
 * Step 2 builds the full-text index; it is optional (see `fts`).
 */
export const MIGRATIONS = [
  // 1: tables.
  (db) => {
    db.exec(`
      CREATE TABLE notebooks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX notes_by_notebook ON notes(notebook_id, updated_at DESC);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX memories_by_time ON memories(updated_at DESC);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  },
  // 2: full-text index over notes, trigram so Chinese can be searched by substring.
  // Without trigram (an SQLite built without it) the step records that and search
  // falls back to LIKE; the version still advances, so the library stays usable.
  (db, options) => {
    let fts = 'none';
    if (options.fts !== false) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            title, body, content='notes', content_rowid='id', tokenize='trigram'
          );
          CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
          END;
          CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
        `);
        fts = 'trigram';
      } catch (error) {
        if (!/no such tokenizer|no such module/i.test(String(error?.message))) throw error;
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fts', fts);
  },
  // 3 (M2): the learning mode of each session the app started in one. Only the DSH session
  // id is kept, never the conversation. `announced` is the mode whose full instructions the
  // session has already been given; it is cleared whenever the mode changes.
  (db) => {
    db.exec(`
      CREATE TABLE session_modes (
        session_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('qa', 'socratic', 'quiz')),
        announced TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
  // 4 (M3): the light knowledge base. A document is kept as its chunks (the text cut with
  // overlap, kb.mjs chunkText), never as a file; vectors, one per chunk and model, are made
  // by the app and stored as float32 BLOBs. Full-text over chunks is trigram like notes',
  // optional the same way (meta kb_fts).
  (db, options) => {
    db.exec(`
      CREATE TABLE kb_documents (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('txt', 'md', 'pdf')),
        source_name TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        -- BCP-47 code the engine detected (for Apple's per-language embedding), '' until then.
        language TEXT NOT NULL DEFAULT '',
        -- Apple embedding: '' not tried yet, 'ok', 'unavailable' (no sentence embedding for
        -- for the language on this device), 'failed'.
        embedding_status TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE kb_chunks (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        UNIQUE (document_id, ordinal)
      ) STRICT;
      CREATE TABLE kb_vectors (
        chunk_id INTEGER NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (chunk_id, model)
      ) STRICT;
      CREATE INDEX kb_vectors_by_model ON kb_vectors(model);
    `);
    let fts = 'none';
    if (options.fts !== false) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
            heading, text, content='kb_chunks', content_rowid='id', tokenize='trigram'
          );
          CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
          END;
          CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
          END;
        `);
        fts = 'trigram';
      } catch (error) {
        if (!/no such tokenizer|no such module/i.test(String(error?.message))) throw error;
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('kb_fts', fts);
  },
  // 5 (M4): the question bank. Questions the model wrote (or the user), every graded answer,
  // and the mistake book (one row per question currently in it, with its run of correct
  // answers since it went in).
  (db) => {
    db.exec(`
      CREATE TABLE quiz_questions (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('choice', 'short')),
        prompt TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        answer TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model', 'user')),
        session_id TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX quiz_questions_by_topic ON quiz_questions(topic, created_at DESC);
      CREATE TABLE quiz_attempts (
        id INTEGER PRIMARY KEY,
        question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
        answer TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'partial', 'incorrect')),
        score REAL NOT NULL,
        graded_by TEXT NOT NULL CHECK (graded_by IN ('rule', 'model', 'user')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX quiz_attempts_by_question ON quiz_attempts(question_id, created_at DESC);
      CREATE TABLE quiz_mistakes (
        question_id INTEGER PRIMARY KEY REFERENCES quiz_questions(id) ON DELETE CASCADE,
        streak INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
  // 6 (M5): Deep Research. A job, its sub-topic blocks, every finished step's output under a
  // deterministic key (the resume log), the citations the steps produced and the claim checks.
  (db) => {
    db.exec(`
      CREATE TABLE research_jobs (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        topic TEXT NOT NULL,
        depth TEXT NOT NULL CHECK (depth IN ('quick', 'standard', 'deep')),
        sources TEXT NOT NULL DEFAULT '[]',
        language TEXT,
        model_target TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'paused', 'done', 'failed', 'cancelled')),
        phase TEXT NOT NULL DEFAULT '',
        progress TEXT NOT NULL DEFAULT '',
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        calls_used INTEGER NOT NULL DEFAULT 0,
        report TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE research_blocks (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        overview TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL CHECK (origin IN ('plan', 'append', 'verify', 'gap')),
        parent_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
        summary TEXT,
        UNIQUE (job_id, ordinal)
      ) STRICT;
      CREATE TABLE research_steps (
        job_id INTEGER NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('llm', 'tool', 'mark')),
        output TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, key)
      ) STRICT;
      CREATE TABLE research_citations (
        job_id INTEGER NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        cit_id TEXT NOT NULL,
        block_id INTEGER,
        tool TEXT NOT NULL,
        query TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        label TEXT,
        chunk_id INTEGER,
        excerpt TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (job_id, cit_id)
      ) STRICT;
      CREATE TABLE research_claims (
        job_id INTEGER NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        claim TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('corroborated', 'single-source', 'conflicting', 'refuted')),
        note TEXT NOT NULL DEFAULT '',
        citations TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (job_id, key)
      ) STRICT;
    `);
  },
  // 7: a session taken out of learning stays on record (学习记录) instead of being forgotten.
  // ended_at: when its mode was ended (NULL while it is in one); hidden: taken off the record
  // by the user (the session itself stays); left_mode: the mode it left, until the model has
  // been told once that learning is over.
  (db) => {
    db.exec(`
      ALTER TABLE session_modes ADD COLUMN ended_at INTEGER;
      ALTER TABLE session_modes ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_modes ADD COLUMN left_mode TEXT;
    `);
  },
  // 8: learning modes that follow a Bot or a group chat (ds-bot) rather than one Session:
  // a Bot's chat moves on to fresh Sessions, and a group runs one Session per member
  // (dsbot.mjs). learning_owner_sessions keeps, per Session the owner spoke in, what full
  // note it was given (mode and role) and which ending it was told about.
  (db) => {
    db.exec(`
      CREATE TABLE learning_owners (
        kind TEXT NOT NULL CHECK (kind IN ('bot', 'room')),
        id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('qa', 'socratic', 'quiz')),
        updated_at INTEGER NOT NULL,
        ended_at INTEGER,
        hidden INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, id)
      ) STRICT;
      CREATE TABLE learning_owner_sessions (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        announced TEXT,
        told_end_at INTEGER,
        PRIMARY KEY (kind, id, session_id)
      ) STRICT;
    `);
  },
  // 9 (D53): mistake-book reviews spaced out in time. due_at: when the question is next up
  // for review, the start of a local day (quiz.mjs nextMistake). Those already in the book
  // are due at once.
  (db) => {
    db.exec(`
      ALTER TABLE quiz_mistakes ADD COLUMN due_at INTEGER;
      UPDATE quiz_mistakes SET due_at = updated_at;
      CREATE INDEX quiz_mistakes_by_due ON quiz_mistakes(due_at);
    `);
  },
  // 10 (D55): Firefly 伙伴. Episodes (shared experiences, with context and feelings), traits
  // (what the companion has seen of the user, by the days it was seen), moods, which messages of
  // a Session have been digested, what each Session was given, and the reaches (speaking first).
  // New tables only: nothing that was there changes.
  (db) => {
    db.exec(`
      CREATE TABLE companion_episodes (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL,
        text TEXT NOT NULL,
        cues TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        emotion REAL NOT NULL DEFAULT 0.3,
        mood TEXT NOT NULL DEFAULT '',
        fact_key TEXT NOT NULL DEFAULT '',
        follow_up TEXT NOT NULL DEFAULT '',
        happened_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        recalls INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        followed_up_at INTEGER,
        superseded_by INTEGER,
        hidden INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX companion_episodes_by_bot ON companion_episodes(bot_id, happened_at DESC);
      CREATE TABLE companion_traits (
        bot_id TEXT NOT NULL,
        key TEXT NOT NULL,
        text TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        days TEXT NOT NULL DEFAULT '[]',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        refuted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_id, key)
      ) STRICT;
      CREATE TABLE companion_moods (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL,
        word TEXT NOT NULL,
        valence REAL NOT NULL DEFAULT 0,
        at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE companion_cursors (
        session_id TEXT PRIMARY KEY,
        digested INTEGER NOT NULL DEFAULT 0,
        last_turn_at INTEGER,
        announced INTEGER NOT NULL DEFAULT 0,
        shown TEXT NOT NULL DEFAULT '[]'
      ) STRICT;
      CREATE TABLE companion_reaches (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'delivered', 'cancelled', 'expired')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        answered_at INTEGER,
        ignored INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  },
  // 11 (D56): 伙伴 in group chats. An episode's scope: 'dm' (the companion's own chat) or
  // 'room:<id>' (a group); a reach that a group's admin posts in its group. New columns only.
  (db) => {
    db.exec(`
      ALTER TABLE companion_episodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'dm';
      ALTER TABLE companion_reaches ADD COLUMN room_id TEXT;
    `);
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const codepoints = (text) => [...text].length;

function text(value, field, max, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new LearningError('invalid', `${field} must be a string`);
  if (codepoints(value) > max) throw new LearningError('invalid', `${field} is longer than ${max} characters`);
  return value;
}

function id(value, field = 'id') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LearningError('invalid', `${field} must be a positive integer`);
  return value;
}

const notebookRow = (row) => row && ({
  id: row.id, title: row.title, noteCount: row.note_count ?? 0, createdAt: row.created_at, updatedAt: row.updated_at,
});
const noteRow = (row) => row && ({
  id: row.id, notebookId: row.notebook_id, title: row.title, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
});
const memoryRow = (row) => row && ({
  id: row.id, content: row.content, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
});

/** Up to `size` characters of `body` around the first place one of `terms` occurs. */
export function excerpt(body, terms, size = 80) {
  const chars = [...body];
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = at < 0 ? 0 : Math.max(0, codepoints(body.slice(0, at)) - Math.floor(size / 4));
  const piece = chars.slice(start, start + size).join('');
  return (start > 0 ? '…' : '') + piece + (start + size < chars.length ? '…' : '');
}

/** The words of a query: split on whitespace, empty ones dropped, at most 8. */
export function queryTerms(query) {
  return query.trim().split(/\s+/u).filter(Boolean).slice(0, 8);
}

export class LearningStore {
  /**
   * @param {string} file - the database, or ':memory:'.
   * @param {{ now?: () => number, fts?: boolean }} [options] - `fts: false` builds no
   *   full-text index (what an SQLite without trigram ends up with); `now` for tests.
   */
  constructor(file, options = {}) {
    this.file = file;
    this.now = options.now ?? Date.now;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      // Check what the file is before changing anything about it: switching to WAL
      // rewrites the header, and a file that is not ours must be left as it was.
      this.#migrate(options);
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #migrate(options) {
    const { application_id: appId } = this.db.prepare('PRAGMA application_id').get();
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (appId !== 0 && appId !== APPLICATION_ID) {
      throw new LearningError('conflict', `${this.file} is not a learning library (application_id ${appId})`);
    }
    if (appId === 0) {
      const tables = this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n;
      if (tables > 0) throw new LearningError('conflict', `${this.file} holds tables that are not a learning library's`);
    }
    if (version > SCHEMA_VERSION) {
      throw new LearningError('conflict', `${this.file} is schema ${version}, newer than this app's ${SCHEMA_VERSION}`);
    }
    for (let step = version; step < SCHEMA_VERSION; step += 1) {
      this.transaction(() => {
        MIGRATIONS[step](this.db, options);
        this.db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${step + 1}`);
      });
    }
  }

  get version() { return this.db.prepare('PRAGMA user_version').get().user_version; }

  /** 'trigram' when notes have a full-text index, 'none' when search scans with LIKE. */
  get fts() { return this.db.prepare("SELECT value FROM meta WHERE key = 'fts'").get()?.value ?? 'none'; }

  /** Run `work` in one transaction: all of it is kept, or none of it if it throws. */
  transaction(work) {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { if (this.db.isOpen) this.db.close(); }

  // Notebooks

  listNotebooks() {
    return this.db.prepare(`
      SELECT b.*, (SELECT count(*) FROM notes n WHERE n.notebook_id = b.id) AS note_count
      FROM notebooks b ORDER BY b.updated_at DESC, b.id DESC
    `).all().map(notebookRow);
  }

  getNotebook(notebookId) {
    const row = this.db.prepare(`
      SELECT b.*, (SELECT count(*) FROM notes n WHERE n.notebook_id = b.id) AS note_count
      FROM notebooks b WHERE b.id = ?
    `).get(id(notebookId));
    if (!row) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return notebookRow(row);
  }

  createNotebook({ title }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO notebooks(title, created_at, updated_at) VALUES (?, ?, ?)',
    ).run(name, now, now);
    return this.getNotebook(Number(lastInsertRowid));
  }

  updateNotebook({ id: notebookId, title }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    const { changes } = this.db.prepare('UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?')
      .run(name, this.now(), id(notebookId));
    if (!changes) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return this.getNotebook(notebookId);
  }

  /** Deletes the notebook and every note in it. */
  deleteNotebook({ id: notebookId }) {
    const { changes } = this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(id(notebookId));
    if (!changes) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return { deleted: true };
  }

  // Notes

  listNotes({ notebookId, limit = 100, offset = 0 }) {
    this.getNotebook(notebookId);
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    return this.db.prepare(`
      SELECT * FROM notes WHERE notebook_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(notebookId, page, Math.max(0, Number(offset) || 0)).map(noteRow);
  }

  getNote({ id: noteId }) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id(noteId));
    if (!row) throw new LearningError('not-found', `no note ${noteId}`);
    return noteRow(row);
  }

  createNote({ notebookId, title = '', body = '' }) {
    text(title, 'title', LIMITS.title);
    text(body, 'body', LIMITS.body);
    return this.transaction(() => {
      this.getNotebook(notebookId);
      const now = this.now();
      const { lastInsertRowid } = this.db.prepare(
        'INSERT INTO notes(notebook_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(notebookId, title, body, now, now);
      this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(now, notebookId);
      return this.getNote({ id: Number(lastInsertRowid) });
    });
  }

  updateNote({ id: noteId, title, body }) {
    text(title, 'title', LIMITS.title, { required: false });
    text(body, 'body', LIMITS.body, { required: false });
    return this.transaction(() => {
      const note = this.getNote({ id: noteId });
      const now = this.now();
      this.db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(title ?? note.title, body ?? note.body, now, noteId);
      this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(now, note.notebookId);
      return this.getNote({ id: noteId });
    });
  }

  deleteNote({ id: noteId }) {
    const { changes } = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id(noteId));
    if (!changes) throw new LearningError('not-found', `no note ${noteId}`);
    return { deleted: true };
  }

  /**
   * Notes whose title or body holds every word of `query`, best first.
   * Trigram matches substrings of three characters or more, so a query with a shorter
   * word (most two-character Chinese words: 函数) scans with LIKE instead; so does every
   * query when the library has no full-text index.
   */
  searchNotes({ query, notebookId, limit = 50 }) {
    const terms = queryTerms(text(query, 'query', LIMITS.query));
    if (!terms.length) return { mode: 'none', results: [] };
    if (notebookId !== undefined) id(notebookId, 'notebookId');
    const page = Math.min(Math.max(1, Number(limit) || 50), LIMITS.page);
    const inBook = notebookId === undefined ? '' : ' AND n.notebook_id = ?';
    const extra = notebookId === undefined ? [] : [notebookId];
    let rows;
    let mode;
    if (this.fts === 'trigram' && terms.every((term) => codepoints(term) >= 3)) {
      mode = 'fts';
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
      rows = this.db.prepare(`
        SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
        WHERE notes_fts MATCH ?${inBook} ORDER BY bm25(notes_fts), n.updated_at DESC LIMIT ?
      `).all(match, ...extra, page);
    } else {
      mode = 'like';
      const escape = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const where = terms.map(() => "(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')").join(' AND ');
      const args = terms.flatMap((term) => [escape(term), escape(term)]);
      rows = this.db.prepare(`
        SELECT n.* FROM notes n WHERE ${where}${inBook} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?
      `).all(...args, ...extra, page);
    }
    return {
      mode,
      results: rows.map((row) => ({
        id: row.id, notebookId: row.notebook_id, title: row.title, excerpt: excerpt(row.body, terms), updatedAt: row.updated_at,
      })),
    };
  }

  // Memories (the learner's long-term memory; not ds-bot's MEMORY.md)

  listMemories({ limit = 200, offset = 0 } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 200), LIMITS.page);
    return this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(page, Math.max(0, Number(offset) || 0)).map(memoryRow);
  }

  getMemory({ id: memoryId }) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id(memoryId));
    if (!row) throw new LearningError('not-found', `no memory ${memoryId}`);
    return memoryRow(row);
  }

  createMemory({ content, source = 'user' }) {
    const value = text(content, 'content', LIMITS.memory).trim();
    if (!value) throw new LearningError('invalid', 'content is empty');
    if (!['user', 'agent'].includes(source)) throw new LearningError('invalid', "source must be 'user' or 'agent'");
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO memories(content, source, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(value, source, now, now);
    return this.getMemory({ id: Number(lastInsertRowid) });
  }

  updateMemory({ id: memoryId, content }) {
    const value = text(content, 'content', LIMITS.memory).trim();
    if (!value) throw new LearningError('invalid', 'content is empty');
    const { changes } = this.db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
      .run(value, this.now(), id(memoryId));
    if (!changes) throw new LearningError('not-found', `no memory ${memoryId}`);
    return this.getMemory({ id: memoryId });
  }

  deleteMemory({ id: memoryId }) {
    const { changes } = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id(memoryId));
    if (!changes) throw new LearningError('not-found', `no memory ${memoryId}`);
    return { deleted: true };
  }

  /** Every learning memory, and nothing else: notes, notebooks and Bot memory stay. */
  clearMemories() {
    const { changes } = this.db.prepare('DELETE FROM memories').run();
    return { deleted: Number(changes) };
  }

  /** The newest `limit` memories, for picking what a turn gets (modes.mjs pickMemories). */
  recentMemories(limit = 500) {
    return this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(limit) || 500, 5_000))).map(memoryRow);
  }

  // Settings (M2): kept in `meta`, inside the learning library, so the engine's settings
  // reset never moves them away and deleting learning data takes them too.

  getSettings() {
    const value = (key) => this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    return {
      injectMemories: value('inject_memories') !== 'off',
      appleEmbedding: value('kb_apple_embedding') !== 'off',
      researchWeb: value('research_web') !== 'off',
    };
  }

  /** Change the settings given; the rest keep their value. */
  updateSettings({ injectMemories, appleEmbedding, researchWeb }) {
    const changes = [
      ['inject_memories', injectMemories, 'injectMemories'],
      ['kb_apple_embedding', appleEmbedding, 'appleEmbedding'],
      ['research_web', researchWeb, 'researchWeb'],
    ].filter(([, value]) => value !== undefined);
    if (!changes.length) throw new LearningError('invalid', 'nothing to change: pass injectMemories, appleEmbedding or researchWeb');
    for (const [, value, name] of changes) {
      if (typeof value !== 'boolean') throw new LearningError('invalid', `${name} must be true or false`);
    }
    const put = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    for (const [key, value] of changes) put.run(key, value ? 'on' : 'off');
    return this.getSettings();
  }

  /**
   * Minutes east of UTC of the phone's clock (480 in China), as the app last sent it with a
   * review or stats call; the engine's own until then. Review days and stats days are its
   * local days, also when the model grades (the engine may not know the phone's zone).
   */
  get tzOffset() {
    const saved = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'tz_offset'").get()?.value);
    return Number.isInteger(saved) ? saved : -new Date(this.now()).getTimezoneOffset();
  }

  /** The offset to use for a call: the one given (kept for later), or the last one. */
  #clock(tzOffset) {
    if (tzOffset === undefined || tzOffset === null) return this.tzOffset;
    if (!Number.isInteger(tzOffset) || Math.abs(tzOffset) > 14 * 60) {
      throw new LearningError('invalid', 'tzOffset must be whole minutes east of UTC, from -840 to 840');
    }
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'tz_offset'").get()?.value !== String(tzOffset)) {
      this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('tz_offset', String(tzOffset));
    }
    return tzOffset;
  }

  // Session modes (M2)

  /** The learning mode of a session, or null for one not in a mode (never, or ended). */
  getSessionMode({ sessionId }) {
    const row = this.db.prepare('SELECT * FROM session_modes WHERE session_id = ? AND ended_at IS NULL').get(sessionKey(sessionId));
    return row ? { sessionId: row.session_id, mode: row.mode, announced: row.announced ?? null, updatedAt: row.updated_at } : null;
  }

  /**
   * Put a session in `mode` (again), or take it out of learning with `mode: null`: it then
   * stays on the learning record, and its next turn is told once that learning is over.
   */
  setSessionMode({ sessionId, mode }) {
    const key = sessionKey(sessionId);
    if (mode === null) {
      const now = this.now();
      this.db.prepare('UPDATE session_modes SET ended_at = ?, left_mode = mode, announced = NULL, updated_at = ? WHERE session_id = ? AND ended_at IS NULL')
        .run(now, now, key);
      return null;
    }
    if (!SESSION_MODES.includes(mode)) throw new LearningError('invalid', `mode must be one of ${SESSION_MODES.join(', ')} or null`);
    this.db.prepare(`
      INSERT INTO session_modes(session_id, mode, announced, updated_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        announced = CASE WHEN session_modes.mode = excluded.mode AND session_modes.ended_at IS NULL THEN session_modes.announced ELSE NULL END,
        mode = excluded.mode,
        updated_at = excluded.updated_at,
        ended_at = NULL,
        hidden = 0,
        left_mode = NULL
    `).run(key, mode, this.now());
    return this.getSessionMode({ sessionId: key });
  }

  /** The mode an ended session left, if its model has not been told yet; telling is this call. */
  takeLeftMode({ sessionId }) {
    const key = sessionKey(sessionId);
    const row = this.db.prepare('SELECT left_mode FROM session_modes WHERE session_id = ? AND ended_at IS NOT NULL').get(key);
    if (!row?.left_mode) return null;
    this.db.prepare('UPDATE session_modes SET left_mode = NULL WHERE session_id = ?').run(key);
    return row.left_mode;
  }

  /** Record that the session has been given `mode`'s full instructions. */
  markAnnounced({ sessionId, mode }) {
    this.db.prepare('UPDATE session_modes SET announced = ? WHERE session_id = ? AND mode = ?')
      .run(mode, sessionKey(sessionId), mode);
  }

  /** The sessions in a learning mode, most recently set first. */
  listSessionModes({ limit = 100 } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    return this.db.prepare('SELECT * FROM session_modes WHERE ended_at IS NULL ORDER BY updated_at DESC, session_id LIMIT ?').all(page)
      .map((row) => ({ sessionId: row.session_id, mode: row.mode, announced: row.announced ?? null, updatedAt: row.updated_at }));
  }

  /** The learning record: sessions whose mode was ended, most recently ended first. */
  listLearningHistory({ limit = 100 } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    return this.db.prepare('SELECT * FROM session_modes WHERE ended_at IS NOT NULL AND hidden = 0 ORDER BY ended_at DESC, session_id LIMIT ?').all(page)
      .map((row) => ({ sessionId: row.session_id, mode: row.mode, endedAt: row.ended_at, updatedAt: row.updated_at }));
  }

  /** Take a session off the learning record. The session itself is not touched. */
  hideLearningHistory({ sessionId }) {
    const { changes } = this.db.prepare('UPDATE session_modes SET hidden = 1 WHERE session_id = ? AND ended_at IS NOT NULL AND hidden = 0').run(sessionKey(sessionId));
    if (!changes) throw new LearningError('not-found', 'that session is not on the learning record');
    return { hidden: true };
  }

  // Learning modes of Bots and group chats (schema 8)

  /** A Bot's or a group's learning mode, or null when it is not in one. */
  getOwnerMode({ kind, id: ownerId }) {
    const row = this.db.prepare('SELECT * FROM learning_owners WHERE kind = ? AND id = ? AND ended_at IS NULL').get(ownerKind(kind), sessionKey(ownerId));
    return row ? ownerRow(row) : null;
  }

  /** Put a Bot or a group in `mode`, or end it with `mode: null` (it stays on the record). */
  setOwnerMode({ kind, id: ownerId, mode }) {
    const k = ownerKind(kind);
    const key = sessionKey(ownerId);
    const now = this.now();
    if (mode === null) {
      this.db.prepare('UPDATE learning_owners SET ended_at = ?, updated_at = ? WHERE kind = ? AND id = ? AND ended_at IS NULL').run(now, now, k, key);
      return null;
    }
    if (!SESSION_MODES.includes(mode)) throw new LearningError('invalid', `mode must be one of ${SESSION_MODES.join(', ')} or null`);
    this.db.prepare(`
      INSERT INTO learning_owners(kind, id, mode, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, ended_at = NULL, hidden = 0
    `).run(k, key, mode, now);
    return this.getOwnerMode({ kind: k, id: key });
  }

  /** Bots and groups in a learning mode, most recently set first. */
  listOwnerModes() {
    return this.db.prepare('SELECT * FROM learning_owners WHERE ended_at IS NULL ORDER BY updated_at DESC, kind, id').all().map(ownerRow);
  }

  /** Bots and groups whose learning mode was ended, most recently ended first. */
  listOwnerHistory() {
    return this.db.prepare('SELECT * FROM learning_owners WHERE ended_at IS NOT NULL AND hidden = 0 ORDER BY ended_at DESC, kind, id').all().map(ownerRow);
  }

  hideOwnerHistory({ kind, id: ownerId }) {
    const { changes } = this.db.prepare('UPDATE learning_owners SET hidden = 1 WHERE kind = ? AND id = ? AND ended_at IS NOT NULL AND hidden = 0').run(ownerKind(kind), sessionKey(ownerId));
    if (!changes) throw new LearningError('not-found', 'that Bot or group is not on the learning record');
    return { hidden: true };
  }

  /**
   * What one Session of an owner was given: `announced` ("<mode>:<role>" of the full note it
   * had) and `toldEndAt` (the ending it was told about). Null for a Session never seen.
   */
  ownerSession({ kind, id: ownerId, sessionId }) {
    const row = this.db.prepare('SELECT announced, told_end_at FROM learning_owner_sessions WHERE kind = ? AND id = ? AND session_id = ?')
      .get(ownerKind(kind), sessionKey(ownerId), sessionKey(sessionId));
    return row ? { announced: row.announced ?? null, toldEndAt: row.told_end_at ?? null } : null;
  }

  markOwnerSession({ kind, id: ownerId, sessionId, announced, toldEndAt }) {
    this.db.prepare(`
      INSERT INTO learning_owner_sessions(kind, id, session_id, announced, told_end_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, id, session_id) DO UPDATE SET announced = excluded.announced, told_end_at = excluded.told_end_at
    `).run(ownerKind(kind), sessionKey(ownerId), sessionKey(sessionId), announced ?? null, toldEndAt ?? null);
  }

  /** The owner's row whatever its state (for the ending note), or null. */
  ownerRecord({ kind, id: ownerId }) {
    const row = this.db.prepare('SELECT * FROM learning_owners WHERE kind = ? AND id = ?').get(ownerKind(kind), sessionKey(ownerId));
    return row ? ownerRow(row) : null;
  }

  // Knowledge base (M3)

  /** 'trigram' when chunks have a full-text index, 'none' when keyword search scans with LIKE. */
  get kbFts() { return this.db.prepare("SELECT value FROM meta WHERE key = 'kb_fts'").get()?.value ?? 'none'; }

  listDocuments() {
    return this.db.prepare('SELECT * FROM kb_documents ORDER BY updated_at DESC, id DESC').all().map(documentRow);
  }

  getDocument({ id: documentId }) {
    const row = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id(documentId));
    if (!row) throw new LearningError('not-found', `no document ${documentId}`);
    return documentRow(row);
  }

  /**
   * Store a document as its chunks. `text` is the document's text: the file itself for
   * txt and md, what the app extracted with PDFKit for a pdf. A pdf with no text (a scan)
   * is refused as `unsupported`: reading scans needs a cloud parser, which is not built.
   */
  importDocument({ title, kind, text: body, sourceName = '' }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    if (!DOCUMENT_KINDS.includes(kind)) throw new LearningError('invalid', `kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
    text(sourceName, 'sourceName', LIMITS.title);
    const content = text(body, 'text', LIMITS.document).replace(/\r\n?/g, '\n');
    if (!content.trim()) {
      if (kind === 'pdf') throw new LearningError('unsupported', 'this PDF has no text layer (a scan?); reading scanned PDFs is not supported yet');
      throw new LearningError('invalid', 'the document has no text');
    }
    const chunks = chunkText(content, { markdown: kind === 'md' });
    return this.transaction(() => {
      const now = this.now();
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO kb_documents(title, kind, source_name, chars, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, kind, sourceName, codepoints(content), chunks.length, now, now);
      const documentId = Number(lastInsertRowid);
      const insert = this.db.prepare(
        'INSERT INTO kb_chunks(document_id, ordinal, start, end, heading, text) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const chunk of chunks) insert.run(documentId, chunk.ordinal, chunk.start, chunk.end, chunk.heading, chunk.text);
      return this.getDocument({ id: documentId });
    });
  }

  /** Deletes the document, its chunks and their vectors. */
  deleteDocument({ id: documentId }) {
    const { changes } = this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id(documentId));
    if (!changes) throw new LearningError('not-found', `no document ${documentId}`);
    return { deleted: true };
  }

  getChunk({ id: chunkId }) {
    const row = this.db.prepare(`
      SELECT c.*, d.title AS document_title, d.chunk_count FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
      WHERE c.id = ?
    `).get(id(chunkId));
    if (!row) throw new LearningError('not-found', `no chunk ${chunkId}`);
    return chunkHit(row);
  }

  /**
   * Chunks that have no vector for `model` yet (or, with `modelPrefix`, for any model
   * starting with it), oldest first, for whoever makes vectors. `documentId` narrows it.
   */
  pendingVectors({ model, modelPrefix, documentId, limit = 64 }) {
    const page = Math.min(Math.max(1, Number(limit) || 64), LIMITS.vectorBatch);
    let match;
    let key;
    if (modelPrefix !== undefined) {
      key = `${modelName(modelPrefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      match = "v.model LIKE ? ESCAPE '\\'";
    } else {
      key = modelName(model);
      match = 'v.model = ?';
    }
    const inDoc = documentId === undefined ? '' : ' AND c.document_id = ?';
    const extra = documentId === undefined ? [] : [id(documentId, 'documentId')];
    return this.db.prepare(`
      SELECT c.id, c.text FROM kb_chunks c
      WHERE NOT EXISTS (SELECT 1 FROM kb_vectors v WHERE v.chunk_id = c.id AND ${match})${inDoc}
      ORDER BY c.id LIMIT ?
    `).all(key, ...extra, page).map((row) => ({ chunkId: row.id, text: row.text }));
  }

  /** Record what the engine found out about a document for Apple's embedding. */
  setDocumentEmbedding({ id: documentId, language, status }) {
    if (language !== undefined && (typeof language !== 'string' || language.length > 35)) {
      throw new LearningError('invalid', 'language must be a BCP-47 code');
    }
    if (status !== undefined && !['', 'ok', 'unavailable', 'failed'].includes(status)) {
      throw new LearningError('invalid', 'status must be "", ok, unavailable or failed');
    }
    const current = this.getDocument({ id: documentId });
    this.db.prepare('UPDATE kb_documents SET language = ?, embedding_status = ? WHERE id = ?')
      .run(language ?? current.language, status ?? current.embeddingStatus, documentId);
    return this.getDocument({ id: documentId });
  }

  /** Documents whose chunks still lack an Apple vector and that are worth trying. */
  documentsToEmbed(prefix) {
    const key = `${modelName(prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db.prepare(`
      SELECT d.* FROM kb_documents d
      WHERE d.embedding_status NOT IN ('unavailable', 'failed') AND EXISTS (
        SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id AND NOT EXISTS (
          SELECT 1 FROM kb_vectors v WHERE v.chunk_id = c.id AND v.model LIKE ? ESCAPE '\\'))
      ORDER BY d.id
    `).all(key).map(documentRow);
  }

  /** The models that have vectors, with their length. */
  vectorModels() {
    return this.db.prepare('SELECT model, dims FROM kb_vectors GROUP BY model, dims ORDER BY model').all()
      .map((row) => ({ model: row.model, dims: row.dims }));
  }

  /**
   * Store vectors made by `model`. Every vector of one model has the same length; the
   * first stored fixes it. A chunk deleted meanwhile is skipped, not an error.
   */
  putVectors({ model, items }) {
    const key = modelName(model);
    if (!Array.isArray(items) || items.length > LIMITS.vectorBatch) {
      throw new LearningError('invalid', `items must be an array of at most ${LIMITS.vectorBatch}`);
    }
    return this.transaction(() => {
      let dims = this.db.prepare('SELECT dims FROM kb_vectors WHERE model = ? LIMIT 1').get(key)?.dims;
      const exists = this.db.prepare('SELECT 1 FROM kb_chunks WHERE id = ?');
      const put = this.db.prepare('INSERT OR REPLACE INTO kb_vectors(chunk_id, model, dims, vector) VALUES (?, ?, ?, ?)');
      let stored = 0;
      for (const item of items) {
        const chunkId = id(item?.chunkId, 'chunkId');
        const vector = item?.vector;
        if (!Array.isArray(vector) || !vector.length || vector.length > LIMITS.dims) {
          throw new LearningError('invalid', `vector must be an array of 1 to ${LIMITS.dims} numbers`);
        }
        dims ??= vector.length;
        if (vector.length !== dims) throw new LearningError('invalid', `${key} vectors have ${dims} dimensions, not ${vector.length}`);
        let blob;
        try { blob = vectorToBlob(vector); } catch (error) { throw new LearningError('invalid', error.message); }
        if (!exists.get(chunkId)) continue;
        put.run(chunkId, key, dims, blob);
        stored += 1;
      }
      return { stored, dims: dims ?? null };
    });
  }

  /** Vector coverage per model: how many chunks have one, out of all chunks. */
  vectorStatus() {
    const chunks = this.db.prepare('SELECT count(*) AS n FROM kb_chunks').get().n;
    const models = this.db.prepare('SELECT model, dims, count(*) AS n FROM kb_vectors GROUP BY model, dims ORDER BY model').all()
      .map((row) => ({ model: row.model, dims: row.dims, chunks: row.n }));
    return { chunks, models };
  }

  /** Forget every vector of `model` (a model the user no longer uses, or one that changed). */
  clearVectors({ model }) {
    const { changes } = this.db.prepare('DELETE FROM kb_vectors WHERE model = ?').run(modelName(model));
    return { deleted: Number(changes) };
  }

  /**
   * Chunks for `query`, best first, each with its citation. Keyword search always runs
   * (trigram FTS when every word has three characters or more, LIKE otherwise, the same
   * rule as notes). When `vector` and `model` are given and chunks have vectors for that
   * model, a cosine ranking runs too and the two are fused by reciprocal rank.
   */
  searchKnowledge({ query, vector, model, queryVectors, documentIds, limit = 8 }) {
    const terms = queryTerms(text(query, 'query', LIMITS.query));
    const page = Math.min(Math.max(1, Number(limit) || 8), 50);
    let inDocs = '';
    let docArgs = [];
    if (documentIds !== undefined) {
      if (!Array.isArray(documentIds) || documentIds.length > 200) throw new LearningError('invalid', 'documentIds must be an array of at most 200 ids');
      docArgs = documentIds.map((value) => id(value, 'documentIds'));
      if (!docArgs.length) return { mode: 'none', results: [] };
      inDocs = ` AND c.document_id IN (${docArgs.map(() => '?').join(', ')})`;
    }
    const pool = 50;
    let keyword = [];
    let keywordMode = 'none';
    if (terms.length) {
      if (this.kbFts === 'trigram' && terms.every((term) => codepoints(term) >= 3)) {
        keywordMode = 'fts';
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
        keyword = this.db.prepare(`
          SELECT c.id FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.rowid
          WHERE kb_chunks_fts MATCH ?${inDocs} ORDER BY bm25(kb_chunks_fts), c.id LIMIT ?
        `).all(match, ...docArgs, pool).map((row) => row.id);
      } else {
        keywordMode = 'like';
        const escape = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const where = terms.map(() => "(c.text LIKE ? ESCAPE '\\' OR c.heading LIKE ? ESCAPE '\\')").join(' AND ');
        keyword = this.db.prepare(`SELECT c.id FROM kb_chunks c WHERE ${where}${inDocs} ORDER BY c.document_id, c.ordinal LIMIT ?`)
          .all(...terms.flatMap((term) => [escape(term), escape(term)]), ...docArgs, pool).map((row) => row.id);
      }
    }
    let semantic = [];
    const queries = [];
    if (vector !== undefined) queries.push({ model, vector });
    if (queryVectors !== undefined) {
      if (!Array.isArray(queryVectors) || queryVectors.length > 8) throw new LearningError('invalid', 'queryVectors must be an array of at most 8');
      queries.push(...queryVectors);
    }
    const rankings = [];
    for (const entry of queries) {
      const key = modelName(entry?.model);
      if (!Array.isArray(entry.vector) || !entry.vector.length) throw new LearningError('invalid', 'vector must be a non-empty array of numbers');
      const query32 = Float32Array.from(entry.vector, Number);
      const rows = this.db.prepare(`
        SELECT v.chunk_id, v.dims, v.vector FROM kb_vectors v JOIN kb_chunks c ON c.id = v.chunk_id WHERE v.model = ?${inDocs}
      `).all(key, ...docArgs);
      if (rows.length && rows[0].dims !== query32.length) {
        throw new LearningError('invalid', `${key} vectors have ${rows[0].dims} dimensions, the query has ${query32.length}`);
      }
      rankings.push(rows
        .map((row) => ({ id: row.chunk_id, score: cosine(query32, blobToVector(row.vector)) }))
        .filter((ranked) => ranked.score > 0)
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .slice(0, pool)
        .map((ranked) => ranked.id));
    }
    semantic = rankings.flat();
    const mode = queries.length ? 'hybrid' : keywordMode;
    if (!keyword.length && !semantic.length) return { mode, results: [] };
    const fused = !queries.length ? keyword.map((chunkId, i) => ({ id: chunkId, score: 1 / (60 + i + 1) }))
      : fuseRanks([keyword, ...rankings]);
    const get = this.db.prepare(`
      SELECT c.*, d.title AS document_title, d.chunk_count FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
      WHERE c.id = ?
    `);
    const results = fused.slice(0, page).map(({ id: chunkId, score }) => {
      const hit = chunkHit(get.get(chunkId));
      return { ...citationOf(hit), score: Number(score.toFixed(6)) };
    });
    return { mode, results };
  }

  // Question bank (M4)

  /** Wrap quiz.mjs's validation errors as library errors. */
  #quiz(work) {
    try {
      return work();
    } catch (error) {
      if (error instanceof QuizError) throw new LearningError('invalid', error.message);
      throw error;
    }
  }

  /** Save questions in one transaction: all of them or none. */
  saveQuestions({ questions, source = 'model', sessionId }) {
    if (!Array.isArray(questions) || !questions.length || questions.length > QUIZ_LIMITS.batch) {
      throw new LearningError('invalid', `questions must be an array of 1 to ${QUIZ_LIMITS.batch}`);
    }
    if (!['model', 'user'].includes(source)) throw new LearningError('invalid', "source must be 'model' or 'user'");
    const session = sessionId === undefined ? null : sessionKey(sessionId);
    const normalized = this.#quiz(() => questions.map((q, i) => {
      try { return normalizeQuestion(q); } catch (error) { throw new QuizError(`question ${i + 1}: ${error.message}`); }
    }));
    return this.transaction(() => {
      const now = this.now();
      const insert = this.db.prepare(`
        INSERT INTO quiz_questions(kind, prompt, options, answer, explanation, topic, source, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return normalized.map((q) => {
        const { lastInsertRowid } = insert.run(q.kind, q.prompt, JSON.stringify(q.options), q.answer, q.explanation, q.topic, source, session, now);
        return this.getQuestion({ id: Number(lastInsertRowid) });
      });
    });
  }

  getQuestion({ id: questionId, withAnswer = true }) {
    const row = this.db.prepare(`
      SELECT q.*, m.streak AS mistake_streak, m.due_at AS mistake_due, m.question_id IS NOT NULL AS in_mistakes,
        (SELECT count(*) FROM quiz_attempts a WHERE a.question_id = q.id) AS attempts,
        (SELECT a.verdict FROM quiz_attempts a WHERE a.question_id = q.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_verdict
      FROM quiz_questions q LEFT JOIN quiz_mistakes m ON m.question_id = q.id WHERE q.id = ?
    `).get(id(questionId));
    if (!row) throw new LearningError('not-found', `no question ${questionId}`);
    return questionRow(row, withAnswer);
  }

  /**
   * Questions newest first; `topic` filters, `mistakes: true` lists the mistake book, `due:
   * true` only its questions up for review now, the longest due first.
   */
  listQuestions({ topic, mistakes = false, due = false, limit = 100, offset = 0, withAnswer = false } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    const where = [];
    const args = [];
    if (topic !== undefined) { where.push('q.topic = ?'); args.push(text(topic, 'topic', QUIZ_LIMITS.topic).trim()); }
    if (mistakes || due) where.push('m.question_id IS NOT NULL');
    if (due) { where.push('coalesce(m.due_at, 0) <= ?'); args.push(this.now()); }
    const order = due ? 'coalesce(m.due_at, 0), m.added_at, q.id,' : mistakes ? 'm.added_at DESC,' : '';
    return this.db.prepare(`
      SELECT q.*, m.streak AS mistake_streak, m.due_at AS mistake_due, m.question_id IS NOT NULL AS in_mistakes,
        (SELECT count(*) FROM quiz_attempts a WHERE a.question_id = q.id) AS attempts,
        (SELECT a.verdict FROM quiz_attempts a WHERE a.question_id = q.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_verdict
      FROM quiz_questions q LEFT JOIN quiz_mistakes m ON m.question_id = q.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order} q.created_at DESC, q.id DESC LIMIT ? OFFSET ?
    `).all(...args, page, Math.max(0, Number(offset) || 0)).map((row) => questionRow(row, withAnswer));
  }

  /**
   * Today's review (D53): the mistake-book questions due now (no answers), how many there
   * are, and when every question in the book comes due (`dueTimes`, soonest first), which the
   * widget counts from as the days go by. `tzOffset`: the phone's (`tzOffset` getter).
   */
  reviewPlan({ tzOffset, limit = 50 } = {}) {
    const zone = this.#clock(tzOffset);
    const now = this.now();
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
    return {
      now,
      tzOffset: zone,
      due: count('SELECT count(*) AS n FROM quiz_mistakes WHERE coalesce(due_at, 0) <= ?', now),
      total: count('SELECT count(*) AS n FROM quiz_mistakes'),
      dueTimes: this.db.prepare('SELECT coalesce(due_at, 0) AS t FROM quiz_mistakes ORDER BY t LIMIT 500').all().map((row) => row.t),
      questions: this.listQuestions({ due: true, limit }),
    };
  }

  /**
   * 学习统计: graded answers per local day over the last `days` (14), days studied in a row,
   * totals, and the most practised topics. A day counts as studied when a question was
   * answered, a note written, a learning memory saved or a research started on it.
   */
  learningStats({ tzOffset, days = 14 } = {}) {
    const zone = this.#clock(tzOffset);
    const span = Math.min(Math.max(1, Number.isInteger(days) ? days : 14), 90);
    const now = this.now();
    const today = dayStart(now, zone);
    const from = today - (span - 1) * DAY_MS;
    const perDay = Array.from({ length: span }, (_, i) => ({ day: from + i * DAY_MS, attempts: 0, correct: 0 }));
    for (const row of this.db.prepare('SELECT verdict, created_at FROM quiz_attempts WHERE created_at >= ?').all(from)) {
      const slot = perDay[Math.round((dayStart(row.created_at, zone) - from) / DAY_MS)];
      if (!slot) continue;
      slot.attempts += 1;
      if (row.verdict === 'correct') slot.correct += 1;
    }
    const since = today - 400 * DAY_MS;
    const studied = new Set();
    for (const sql of [
      'SELECT created_at AS t FROM quiz_attempts WHERE created_at >= ?',
      'SELECT updated_at AS t FROM notes WHERE updated_at >= ?',
      'SELECT created_at AS t FROM memories WHERE created_at >= ?',
      'SELECT created_at AS t FROM research_jobs WHERE created_at >= ?',
    ]) for (const row of this.db.prepare(sql).all(since)) studied.add(dayStart(row.t, zone));
    // Today not studied yet does not break the run: it counts up to yesterday.
    let day = studied.has(today) ? today : today - DAY_MS;
    let streak = 0;
    while (studied.has(day)) { streak += 1; day -= DAY_MS; }
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
    const totals = {
      questions: count('SELECT count(*) AS n FROM quiz_questions'),
      attempts: count('SELECT count(*) AS n FROM quiz_attempts'),
      correct: count("SELECT count(*) AS n FROM quiz_attempts WHERE verdict = 'correct'"),
      mistakes: count('SELECT count(*) AS n FROM quiz_mistakes'),
      dueNow: count('SELECT count(*) AS n FROM quiz_mistakes WHERE coalesce(due_at, 0) <= ?', now),
      dueThisWeek: count('SELECT count(*) AS n FROM quiz_mistakes WHERE coalesce(due_at, 0) < ?', today + 7 * DAY_MS),
      // Once answered short of correct and out of the mistake book now.
      mastered: count(`SELECT count(*) AS n FROM quiz_questions q
        WHERE EXISTS (SELECT 1 FROM quiz_attempts a WHERE a.question_id = q.id AND a.verdict <> 'correct')
          AND NOT EXISTS (SELECT 1 FROM quiz_mistakes m WHERE m.question_id = q.id)`),
      notes: count('SELECT count(*) AS n FROM notes'),
      memories: count('SELECT count(*) AS n FROM memories'),
      documents: count('SELECT count(*) AS n FROM kb_documents'),
      research: count("SELECT count(*) AS n FROM research_jobs WHERE status = 'done'"),
    };
    const topics = this.db.prepare(`
      SELECT q.topic, count(DISTINCT q.id) AS questions, count(a.id) AS attempts,
        coalesce(sum(a.verdict = 'correct'), 0) AS correct,
        (SELECT count(*) FROM quiz_mistakes m JOIN quiz_questions q2 ON q2.id = m.question_id WHERE q2.topic = q.topic) AS mistakes
      FROM quiz_questions q LEFT JOIN quiz_attempts a ON a.question_id = q.id
      GROUP BY q.topic ORDER BY attempts DESC, questions DESC, q.topic LIMIT 12
    `).all().map((row) => ({ topic: row.topic, questions: row.questions, attempts: row.attempts, correct: row.correct, mistakes: row.mistakes }));
    return { now, tzOffset: zone, days: perDay, streakDays: streak, studiedToday: studied.has(today), totals, topics };
  }

  /** Topics with their question and mistake counts. */
  quizTopics() {
    return this.db.prepare(`
      SELECT q.topic, count(*) AS questions, count(m.question_id) AS mistakes
      FROM quiz_questions q LEFT JOIN quiz_mistakes m ON m.question_id = q.id GROUP BY q.topic ORDER BY q.topic
    `).all().map((row) => ({ topic: row.topic, questions: row.questions, mistakes: row.mistakes }));
  }

  deleteQuestion({ id: questionId }) {
    const { changes } = this.db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(id(questionId));
    if (!changes) throw new LearningError('not-found', `no question ${questionId}`);
    return { deleted: true };
  }

  /**
   * Grade an answer, record it, and move the question in or out of the mistake book, in
   * one transaction. `judged` is the model's own verdict for a short answer;
   * `gradedBy: 'user'` with `judged` is the learner overruling the grade in the app.
   */
  answerQuestion({ id: questionId, answer, judged, gradedBy, tzOffset }) {
    return this.transaction(() => {
      const zone = this.#clock(tzOffset);
      const question = this.getQuestion({ id: questionId });
      if (gradedBy !== undefined && gradedBy !== 'user') throw new LearningError('invalid', "gradedBy can only be 'user'");
      const result = this.#quiz(() => {
        if (gradedBy === 'user') {
          if (!['correct', 'partial', 'incorrect'].includes(judged)) throw new QuizError('judged must be correct, partial or incorrect');
          return { verdict: judged, score: judged === 'correct' ? 1 : judged === 'partial' ? 0.5 : 0, gradedBy: 'user' };
        }
        return grade(question, answer, { judged: question.kind === 'short' ? judged : undefined });
      });
      const given = typeof answer === 'string' ? answer.trim().slice(0, QUIZ_LIMITS.answer) : String(answer ?? '');
      const now = this.now();
      this.db.prepare('INSERT INTO quiz_attempts(question_id, answer, verdict, score, graded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(question.id, result.chosen ?? given, result.verdict, result.score, result.gradedBy, now);
      const row = this.db.prepare('SELECT streak, due_at FROM quiz_mistakes WHERE question_id = ?').get(question.id);
      const entry = row ? { streak: row.streak, dueAt: row.due_at ?? null } : null;
      // The learner overruling a grade says how the answer went, not when: it counts.
      const next = nextMistake(entry, result.verdict, { now, tzOffset: zone, mastery: this.mastery, counts: result.gradedBy === 'user' });
      if (next.action === 'add') {
        this.db.prepare('INSERT INTO quiz_mistakes(question_id, streak, added_at, updated_at, due_at) VALUES (?, 0, ?, ?, ?)').run(question.id, now, now, next.dueAt);
      } else if (next.action === 'reset' || next.action === 'progress') {
        this.db.prepare('UPDATE quiz_mistakes SET streak = ?, updated_at = ?, due_at = ? WHERE question_id = ?').run(next.streak, now, next.dueAt, question.id);
      } else if (next.action === 'remove') {
        this.db.prepare('DELETE FROM quiz_mistakes WHERE question_id = ?').run(question.id);
      }
      // No field is ever undefined: the model tool hands this on as lossless JSON (wire.mjs).
      return {
        questionId: question.id,
        verdict: result.verdict,
        score: result.score,
        gradedBy: result.gradedBy,
        ...(result.chosen !== undefined ? { chosen: result.chosen } : {}),
        correctAnswer: question.answer,
        explanation: question.explanation ?? null,
        mistakeBook: next.action === 'none' ? 'not-in' : next.action === 'remove' ? 'removed'
          : next.action === 'add' ? 'added' : 'in',
        ...(next.action === 'remove' || next.action === 'none' ? {} : { streak: next.streak, dueAt: next.dueAt }),
        // Right, but before its review day: it does not count toward leaving the book.
        ...(next.action === 'early' ? { early: true } : {}),
        mastery: this.mastery,
      };
    });
  }

  /** How many correct answers in a row take a question out of the mistake book. */
  get mastery() { return MASTERY; }

  // Firefly 伙伴 (D55, companion.mjs)

  /** The phone's clock for what follows (kept, as with a review call). */
  useClock(tzOffset) { return this.#clock(tzOffset); }

  /**
   * Which Bot is the companion ('' for none), whether it may speak first, its quiet hours;
   * whether group admins are companions in their groups too (D56, on) and whether the
   * companion's private chat may come to mind in a group (off).
   */
  companionSettings() {
    const get = (key) => this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    const hour = (key, fallback) => { const v = Number(get(key)); return Number.isInteger(v) && v >= 0 && v < 24 ? v : fallback; };
    return {
      botId: get('companion_bot') ?? '', reach: get('companion_reach') !== 'off',
      quietStart: hour('companion_quiet_start', 23), quietEnd: hour('companion_quiet_end', 8),
      groupAdmins: get('companion_group_admins') !== 'off', groupRecallDm: get('companion_group_recall_dm') === 'on',
    };
  }

  updateCompanionSettings({ botId, reach, quietStart, quietEnd, groupAdmins, groupRecallDm }) {
    const put = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    if (botId !== undefined) put.run('companion_bot', text(botId, 'botId', 200).trim());
    for (const [key, value, name] of [['companion_reach', reach, 'reach'], ['companion_group_admins', groupAdmins, 'groupAdmins'], ['companion_group_recall_dm', groupRecallDm, 'groupRecallDm']]) {
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new LearningError('invalid', `${name} must be true or false`);
      put.run(key, value ? 'on' : 'off');
    }
    for (const [key, value] of [['companion_quiet_start', quietStart], ['companion_quiet_end', quietEnd]]) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > 23) throw new LearningError('invalid', 'quiet hours are whole hours from 0 to 23');
      put.run(key, String(value));
    }
    return this.companionSettings();
  }

  /**
   * Episodes, newest first: a Bot's (or every Bot's when `botId` is undefined), in `scopes`
   * when given ('dm', 'room:<id>'); `all` includes hidden and superseded ones.
   */
  companionEpisodes({ botId, all = false, limit = 500, scopes } = {}) {
    const where = [];
    const args = [];
    if (botId !== undefined) { where.push('bot_id = ?'); args.push(text(botId, 'botId', 200)); }
    if (!all) where.push('hidden = 0 AND superseded_by IS NULL');
    if (Array.isArray(scopes)) { where.push(`scope IN (${scopes.map(() => '?').join(', ') || "''"})`); args.push(...scopes); }
    return this.db.prepare(`SELECT * FROM companion_episodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY happened_at DESC, id DESC LIMIT ?`).all(...args, Math.min(Math.max(1, Number(limit) || 500), 2000)).map(episodeRow);
  }

  /**
   * Keep a digest: its episodes (one with a fact key takes the place of the older one with the
   * same key, which stays as history), the traits it saw (a day of evidence each), the mood,
   * and what the user asked to be forgotten (episodes holding every word of one are hidden).
   */
  saveDigest({ botId, digest, happenedAt, scope = 'dm' }) {
    const bot = text(botId, 'botId', 200);
    if (scope !== 'dm' && !/^room:.{1,200}$/s.test(scope)) throw new LearningError('invalid', "scope must be 'dm' or 'room:<id>'");
    return this.transaction(() => {
      const now = this.now();
      const zone = this.tzOffset;
      const ids = [];
      for (const e of digest.episodes ?? []) {
        const { lastInsertRowid } = this.db.prepare(`INSERT INTO companion_episodes(bot_id, text, cues, importance, emotion, mood, fact_key, follow_up, happened_at, created_at, scope)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(bot, e.text, JSON.stringify(e.cues ?? []), e.importance, e.emotion, e.mood ?? '', e.key ?? '', e.followUp ?? '', happenedAt ?? now, now, scope);
        const id = Number(lastInsertRowid);
        ids.push(id);
        if (e.key) {
          this.db.prepare('UPDATE companion_episodes SET superseded_by = ? WHERE bot_id = ? AND fact_key = ? AND id <> ? AND superseded_by IS NULL').run(id, bot, e.key, id);
        }
      }
      const day = dayStart(happenedAt ?? now, zone);
      for (const t of digest.traits ?? []) {
        const row = this.db.prepare('SELECT * FROM companion_traits WHERE bot_id = ? AND key = ?').get(bot, t.key);
        if (!row) {
          this.db.prepare('INSERT INTO companion_traits(bot_id, key, text, evidence, days, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(bot, t.key, t.text, t.evidence, JSON.stringify([day]), now, now);
          continue;
        }
        const days = new Set(JSON.parse(row.days));
        days.add(day);
        // Seen again: the newer wording, the evidence of this time; a refuted one starts over.
        this.db.prepare('UPDATE companion_traits SET text = ?, evidence = ?, days = ?, last_seen = ?, refuted = 0 WHERE bot_id = ? AND key = ?')
          .run(t.text, t.evidence, JSON.stringify([...days].sort((a, b) => a - b).slice(-20)), now, bot, t.key);
        if (row.refuted) this.db.prepare('UPDATE companion_traits SET days = ? WHERE bot_id = ? AND key = ?').run(JSON.stringify([day]), bot, t.key);
      }
      if (digest.mood) this.db.prepare('INSERT INTO companion_moods(bot_id, word, valence, at) VALUES (?, ?, ?, ?)').run(bot, digest.mood.word, digest.mood.valence, happenedAt ?? now);
      let hidden = 0;
      for (const words of digest.retract ?? []) {
        for (const e of this.companionEpisodes({ botId: bot })) {
          if (!ids.includes(e.id) && [e.text, ...e.cues].join(' ').includes(words)) {
            this.db.prepare('UPDATE companion_episodes SET hidden = 1 WHERE id = ?').run(e.id);
            hidden += 1;
          }
        }
      }
      return { episodes: ids, hidden };
    });
  }

  /** Digests run today for a Bot (each is a model call; the daily limit counts them). */
  companionDigestsToday(botId) {
    const [day, count] = String(this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`companion_digests:${botId}`)?.value ?? '').split(':').map(Number);
    return day === dayStart(this.now(), this.tzOffset) && Number.isInteger(count) ? count : 0;
  }

  /** One more digest today, whatever it kept. */
  countDigest(botId) {
    const today = dayStart(this.now(), this.tzOffset);
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`companion_digests:${botId}`, `${today}:${this.companionDigestsToday(botId) + 1}`);
  }

  /** A Bot's traits (every Bot's when `botId` is undefined); `all` includes refuted ones. */
  companionTraits({ botId, all = false } = {}) {
    const where = [];
    const args = [];
    if (botId !== undefined) { where.push('bot_id = ?'); args.push(text(botId, 'botId', 200)); }
    if (!all) where.push('refuted = 0');
    return this.db.prepare(`SELECT * FROM companion_traits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC`).all(...args)
      .map((t) => ({ botId: t.bot_id, key: t.key, text: t.text, evidence: t.evidence, days: JSON.parse(t.days), firstSeen: t.first_seen, lastSeen: t.last_seen, refuted: Boolean(t.refuted) }));
  }

  /** The user says a trait is wrong: it leaves what the companion is told until seen again. */
  refuteTrait({ botId, key }) {
    const { changes } = this.db.prepare('UPDATE companion_traits SET refuted = 1 WHERE bot_id = ? AND key = ?').run(text(botId, 'botId', 200), text(key, 'key', 40));
    if (!changes) throw new LearningError('not-found', `no trait ${key}`);
    return { refuted: true };
  }

  companionMoods({ botId, limit = 30 }) {
    return this.db.prepare('SELECT * FROM companion_moods WHERE bot_id = ? ORDER BY at DESC LIMIT ?').all(text(botId, 'botId', 200), limit)
      .map((m) => ({ word: m.word, valence: m.valence, at: m.at }));
  }

  /** Hide (the user removed it) or show again an episode. Nothing is deleted. */
  hideEpisode({ id: episodeId, hidden = true }) {
    const { changes } = this.db.prepare('UPDATE companion_episodes SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id(episodeId));
    if (!changes) throw new LearningError('not-found', `no episode ${episodeId}`);
    return { hidden };
  }

  /** Episodes came to mind: count it (they last longer) and remember the time (a pause before the next). */
  markRecalled(ids, sessionId) {
    const now = this.now();
    for (const episodeId of ids) this.db.prepare('UPDATE companion_episodes SET recalls = recalls + 1, last_recalled_at = ? WHERE id = ?').run(now, episodeId);
    const cursor = this.companionCursor(sessionId);
    this.db.prepare('UPDATE companion_cursors SET shown = ? WHERE session_id = ?').run(JSON.stringify([...new Set([...cursor.shown, ...ids])].slice(-200)), sessionId);
  }

  markFollowedUp(episodeId) {
    this.db.prepare('UPDATE companion_episodes SET followed_up_at = ? WHERE id = ?').run(this.now(), episodeId);
  }

  /** A Session's place: messages digested, its last turn, whether it got the session note, what it was shown. */
  companionCursor(sessionId) {
    const sid = sessionKey(sessionId);
    this.db.prepare('INSERT OR IGNORE INTO companion_cursors(session_id) VALUES (?)').run(sid);
    const row = this.db.prepare('SELECT * FROM companion_cursors WHERE session_id = ?').get(sid);
    return { sessionId: sid, digested: row.digested, lastTurnAt: row.last_turn_at ?? null, announced: Boolean(row.announced), shown: JSON.parse(row.shown) };
  }

  updateCompanionCursor(sessionId, { digested, lastTurnAt, announced }) {
    const sid = sessionKey(sessionId);
    this.companionCursor(sid);
    if (digested !== undefined) this.db.prepare('UPDATE companion_cursors SET digested = ? WHERE session_id = ?').run(digested, sid);
    if (lastTurnAt !== undefined) this.db.prepare('UPDATE companion_cursors SET last_turn_at = ? WHERE session_id = ?').run(lastTurnAt, sid);
    if (announced !== undefined) this.db.prepare('UPDATE companion_cursors SET announced = ? WHERE session_id = ?').run(announced ? 1 : 0, sid);
  }

  /** When the user last talked where `key` names: a companion Bot's id (its chat) or 'room:<id>'. */
  companionLastUserAt(key) {
    return this.db.prepare("SELECT CAST(value AS INTEGER) AS t FROM meta WHERE key = ?").get(`companion_last_user:${key}`)?.t ?? null;
  }

  /**
   * The user talked to a companion (`key`: its chat, or 'room:<id>'): planned reaches are called
   * off, wherever they were going (they came back on their own), and the last delivered one is
   * answered if within the window, ignored if not.
   */
  companionUserTurn(key, answerMs) {
    const now = this.now();
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`companion_last_user:${key}`, String(now));
    const cancelled = this.db.prepare("SELECT id FROM companion_reaches WHERE status = 'planned'").all().map((r) => r.id);
    this.db.prepare("UPDATE companion_reaches SET status = 'cancelled' WHERE status = 'planned'").run();
    const last = this.db.prepare("SELECT * FROM companion_reaches WHERE status = 'delivered' AND answered_at IS NULL AND ignored = 0 ORDER BY delivered_at DESC LIMIT 1").get();
    if (last) {
      if (now - last.delivered_at <= answerMs) this.db.prepare('UPDATE companion_reaches SET answered_at = ? WHERE id = ?').run(now, last.id);
      else this.db.prepare('UPDATE companion_reaches SET ignored = 1 WHERE id = ?').run(last.id);
    }
    return { cancelled };
  }

  /** Delivered reaches unanswered past the window count as ignored now. */
  settleIgnoredReaches(answerMs) {
    this.db.prepare("UPDATE companion_reaches SET ignored = 1 WHERE status = 'delivered' AND answered_at IS NULL AND ignored = 0 AND delivered_at < ?")
      .run(this.now() - answerMs);
  }

  /** Ignored reaches in a row since the last answered one (expired ones count too), wherever they went. */
  ignoredReaches() {
    let n = 0;
    for (const r of this.db.prepare("SELECT * FROM companion_reaches WHERE status IN ('delivered', 'expired') ORDER BY fire_at DESC LIMIT 10").all()) {
      if (r.answered_at) break;
      if (r.ignored || r.status === 'expired') n += 1; else break;
    }
    return n;
  }

  /** Reaches, newest first: a Bot's, or all when `botId` is undefined. */
  companionReaches({ botId, status, limit = 20 } = {}) {
    const where = [];
    const args = [];
    if (botId !== undefined) { where.push('bot_id = ?'); args.push(botId); }
    if (status !== undefined) { where.push('status = ?'); args.push(status); }
    return this.db.prepare(`SELECT * FROM companion_reaches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY fire_at DESC LIMIT ?`).all(...args, limit).map(reachRow);
  }

  addReach({ botId, roomId, fireAt, text: words }) {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO companion_reaches(bot_id, room_id, fire_at, text, status, created_at) VALUES (?, ?, ?, ?, 'planned', ?)")
      .run(botId, roomId ?? null, fireAt, words, this.now());
    return reachRow(this.db.prepare('SELECT * FROM companion_reaches WHERE id = ?').get(Number(lastInsertRowid)));
  }

  setReachStatus(reachId, status) {
    this.db.prepare(`UPDATE companion_reaches SET status = ?${status === 'delivered' ? ', delivered_at = ?' : ''} WHERE id = ?`)
      .run(...(status === 'delivered' ? [status, this.now(), reachId] : [status, reachId]));
  }

  /** One question's attempts, newest first. */
  listAttempts({ questionId, limit = 50 }) {
    this.getQuestion({ id: questionId });
    return this.db.prepare('SELECT * FROM quiz_attempts WHERE question_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(questionId, Math.min(Math.max(1, Number(limit) || 50), LIMITS.page))
      .map((row) => ({ id: row.id, answer: row.answer, verdict: row.verdict, score: row.score, gradedBy: row.graded_by, createdAt: row.created_at }));
  }

  // Deep Research (M5)

  createResearchJob({ topic, depth = 'standard', sources = ['web', 'kb'], sessionId, language }) {
    const subject = text(topic, 'topic', 2_000).trim();
    if (!subject) throw new LearningError('invalid', 'topic is empty');
    if (!RESEARCH_DEPTHS.includes(depth)) throw new LearningError('invalid', `depth must be one of ${RESEARCH_DEPTHS.join(', ')}`);
    if (!Array.isArray(sources) || !sources.length || sources.some((s) => !['web', 'kb'].includes(s))) {
      throw new LearningError('invalid', "sources must be a non-empty list of 'web' and 'kb'");
    }
    if (language !== undefined) text(language, 'language', 50);
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO research_jobs(session_id, topic, depth, sources, language, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)
    `).run(sessionId === undefined ? null : sessionKey(sessionId), subject, depth, JSON.stringify([...new Set(sources)]), language ?? null, now, now);
    return this.getResearchJob({ id: Number(lastInsertRowid) });
  }

  getResearchJob({ id: jobId, withReport = true }) {
    const row = this.db.prepare(`
      SELECT j.*, (SELECT count(*) FROM research_blocks b WHERE b.job_id = j.id) AS blocks,
        (SELECT count(*) FROM research_blocks b WHERE b.job_id = j.id AND b.status = 'done') AS blocks_done,
        (SELECT count(*) FROM research_citations c WHERE c.job_id = j.id) AS citations
      FROM research_jobs j WHERE j.id = ?
    `).get(id(jobId));
    if (!row) throw new LearningError('not-found', `no research job ${jobId}`);
    return researchRow(row, withReport);
  }

  listResearchJobs({ limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT j.*, (SELECT count(*) FROM research_blocks b WHERE b.job_id = j.id) AS blocks,
        (SELECT count(*) FROM research_blocks b WHERE b.job_id = j.id AND b.status = 'done') AS blocks_done,
        (SELECT count(*) FROM research_citations c WHERE c.job_id = j.id) AS citations
      FROM research_jobs j ORDER BY j.updated_at DESC, j.id DESC LIMIT ?
    `).all(Math.min(Math.max(1, Number(limit) || 50), LIMITS.page)).map((row) => researchRow(row, false));
  }

  setResearchStatus({ id: jobId, status, phase, progress }) {
    this.db.prepare(`
      UPDATE research_jobs SET status = ?, phase = coalesce(?, phase), progress = coalesce(?, progress), updated_at = ?
      WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')
    `).run(status, phase ?? null, progress ?? null, this.now(), id(jobId));
  }

  finishResearch({ id: jobId, status, report, error }) {
    this.db.prepare(`
      UPDATE research_jobs SET status = ?, report = coalesce(?, report), error = ?, phase = ?, progress = '', updated_at = ?
      WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')
    `).run(status, report ?? null, error ?? null, status, this.now(), id(jobId));
  }

  /** Ask a job to stop: it ends `cancelled` after the step in progress. A job not running stops now. */
  cancelResearch({ id: jobId }) {
    const job = this.getResearchJob({ id: jobId, withReport: false });
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'running') {
      this.db.prepare('UPDATE research_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(this.now(), job.id);
    } else {
      this.finishResearch({ id: job.id, status: 'cancelled' });
    }
    return this.getResearchJob({ id: job.id, withReport: false });
  }

  /** The model a job runs with (kept so the app can resume it without a session turn). */
  setResearchTarget({ id: jobId, target }) {
    this.db.prepare('UPDATE research_jobs SET model_target = ? WHERE id = ?').run(JSON.stringify({ provider: target.provider, model: target.model }), id(jobId));
  }

  /** At engine start nothing runs yet: jobs left `running` by a stopped engine become `paused`. */
  pauseInterruptedResearch() {
    const { changes } = this.db.prepare("UPDATE research_jobs SET status = 'paused', updated_at = ? WHERE status = 'running'").run(this.now());
    return { paused: Number(changes) };
  }

  deleteResearchJob({ id: jobId }) {
    const { changes } = this.db.prepare('DELETE FROM research_jobs WHERE id = ?').run(id(jobId));
    if (!changes) throw new LearningError('not-found', `no research job ${jobId}`);
    return { deleted: true };
  }

  getResearchStep({ jobId, key }) {
    const row = this.db.prepare('SELECT * FROM research_steps WHERE job_id = ? AND key = ?').get(jobId, key);
    return row ? { key: row.key, kind: row.kind, output: row.output } : null;
  }

  /** Store a step's output and count a model call, in one transaction; a key already there is kept. */
  putResearchStep({ jobId, key, kind, output }) {
    this.transaction(() => {
      const { changes } = this.db.prepare('INSERT OR IGNORE INTO research_steps(job_id, key, kind, output, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(jobId, key, kind, output, this.now());
      if (changes && kind === 'llm') this.db.prepare('UPDATE research_jobs SET calls_used = calls_used + 1, updated_at = ? WHERE id = ?').run(this.now(), jobId);
    });
  }

  listResearchSteps({ jobId }) {
    return this.db.prepare('SELECT key, kind FROM research_steps WHERE job_id = ? ORDER BY rowid').all(jobId).map((row) => ({ key: row.key, kind: row.kind }));
  }

  /**
   * Add blocks at the end of the queue. With `stepKey` this happens once: the key is stored
   * in the same transaction, and a second call with it adds nothing.
   */
  addResearchBlocks({ jobId, origin, blocks, parentId = null, stepKey }) {
    return this.transaction(() => {
      if (stepKey && this.getResearchStep({ jobId, key: stepKey })) return [];
      let ordinal = this.db.prepare('SELECT coalesce(max(ordinal), 0) AS n FROM research_blocks WHERE job_id = ?').get(jobId).n;
      const insert = this.db.prepare('INSERT INTO research_blocks(job_id, ordinal, title, overview, origin, parent_id) VALUES (?, ?, ?, ?, ?, ?)');
      const ids = blocks.map((b) => {
        ordinal += 1;
        return Number(insert.run(jobId, ordinal, b.title.slice(0, 300), (b.overview ?? '').slice(0, 1_000), origin, parentId).lastInsertRowid);
      });
      if (stepKey) this.db.prepare('INSERT INTO research_steps(job_id, key, kind, output, created_at) VALUES (?, ?, \'mark\', ?, ?)').run(jobId, stepKey, JSON.stringify(ids), this.now());
      return ids;
    });
  }

  listResearchBlocks({ jobId }) {
    return this.db.prepare('SELECT * FROM research_blocks WHERE job_id = ? ORDER BY ordinal').all(jobId).map((row) => ({
      id: row.id, ordinal: row.ordinal, title: row.title, overview: row.overview, origin: row.origin,
      parentId: row.parent_id ?? null, status: row.status, summary: row.summary ?? null,
    }));
  }

  setResearchBlock({ id: blockId, status, summary }) {
    this.db.prepare('UPDATE research_blocks SET status = ?, summary = coalesce(?, summary) WHERE id = ?').run(status, summary ?? null, blockId);
  }

  /**
   * Record citations for one tool step. Ids are derived from the step key, so the same step
   * replayed on resume records nothing new. Returns the citations with the raw text to note.
   */
  addCitations({ jobId, blockId, tool, query, stepKey, items }) {
    const base = `CIT-${stepKey.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO research_citations(job_id, cit_id, block_id, tool, query, title, url, label, chunk_id, excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.transaction(() => items.map((item, i) => {
      const citId = `${base}-${i + 1}`;
      insert.run(jobId, citId, blockId ?? null, tool, String(query).slice(0, 500), String(item.title ?? '').slice(0, 300) || tool,
        item.url ?? null, item.label ?? null, item.chunkId ?? null, String(item.raw).slice(0, 2_000));
      return { citId, raw: String(item.raw) };
    }));
  }

  setCitationNote({ jobId, citId, note }) {
    this.db.prepare('UPDATE research_citations SET note = ? WHERE job_id = ? AND cit_id = ?').run(String(note).slice(0, 4_000), jobId, citId);
  }

  listCitations({ jobId }) {
    return this.db.prepare('SELECT * FROM research_citations WHERE job_id = ? ORDER BY rowid').all(jobId).map((row) => ({
      citId: row.cit_id, blockId: row.block_id ?? null, tool: row.tool, query: row.query, title: row.title,
      url: row.url ?? null, label: row.label ?? null, chunkId: row.chunk_id ?? null, excerpt: row.excerpt, note: row.note ?? null,
    }));
  }

  /** A block's evidence as the research loop shows it (or how many citations it has). */
  blockEvidence({ jobId, blockId, count = false }) {
    const rows = this.db.prepare('SELECT * FROM research_citations WHERE job_id = ? AND block_id = ? ORDER BY rowid').all(jobId, blockId);
    if (count) return rows.length;
    return rows.map((row) => `[${row.cit_id}] ${row.title}${row.url ? ` (${row.url})` : row.label ? ` (${row.label})` : ''}: ${(row.note || row.excerpt).slice(0, 700)}`).join('\n');
  }

  putClaim({ jobId, key, claim, status, note, citations }) {
    this.db.prepare('INSERT OR REPLACE INTO research_claims(job_id, key, claim, status, note, citations) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, key, claim.slice(0, 1_000), status, String(note ?? '').slice(0, 1_000), JSON.stringify(citations ?? []));
  }

  listClaims({ jobId }) {
    return this.db.prepare('SELECT * FROM research_claims WHERE job_id = ? ORDER BY rowid').all(jobId)
      .map((row) => ({ key: row.key, claim: row.claim, status: row.status, note: row.note, citations: JSON.parse(row.citations) }));
  }
}

/** Research depths; the table's CHECK holds the same list. */
export const RESEARCH_DEPTHS = ['quick', 'standard', 'deep'];

const researchRow = (row, withReport) => row && ({
  id: row.id, sessionId: row.session_id ?? null, topic: row.topic, depth: row.depth, sources: JSON.parse(row.sources),
  language: row.language ?? null, target: row.model_target ? JSON.parse(row.model_target) : null, status: row.status, phase: row.phase, progress: row.progress,
  cancelRequested: Boolean(row.cancel_requested), callsUsed: row.calls_used, blocks: row.blocks ?? 0,
  blocksDone: row.blocks_done ?? 0, citations: row.citations ?? 0, error: row.error ?? null,
  ...(withReport ? { report: row.report ?? null } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
});

const questionRow = (row, withAnswer) => row && ({
  id: row.id, kind: row.kind, prompt: row.prompt, options: JSON.parse(row.options),
  ...(withAnswer ? { answer: row.answer, explanation: row.explanation } : {}),
  topic: row.topic, source: row.source, sessionId: row.session_id ?? null, createdAt: row.created_at,
  attempts: row.attempts ?? 0, lastVerdict: row.last_verdict ?? null,
  inMistakes: Boolean(row.in_mistakes), mistakeStreak: row.in_mistakes ? row.mistake_streak : null,
  reviewAt: row.in_mistakes ? (row.mistake_due ?? 0) : null,
});

/** The document kinds the knowledge base takes; the table's CHECK holds the same list. */
export const DOCUMENT_KINDS = ['txt', 'md', 'pdf'];

const episodeRow = (row) => row && ({
  id: row.id, botId: row.bot_id, text: row.text, cues: JSON.parse(row.cues), importance: row.importance, emotion: row.emotion,
  mood: row.mood, key: row.fact_key, followUp: row.follow_up, happenedAt: row.happened_at, createdAt: row.created_at,
  recalls: row.recalls, lastRecalledAt: row.last_recalled_at ?? null, followedUpAt: row.followed_up_at ?? null,
  supersededBy: row.superseded_by ?? null, hidden: Boolean(row.hidden), scope: row.scope ?? 'dm',
});

const reachRow = (row) => row && ({
  id: row.id, botId: row.bot_id, roomId: row.room_id ?? null, fireAt: row.fire_at, text: row.text, status: row.status, createdAt: row.created_at,
  deliveredAt: row.delivered_at ?? null, answeredAt: row.answered_at ?? null, ignored: Boolean(row.ignored),
});

const documentRow = (row) => row && ({
  id: row.id, title: row.title, kind: row.kind, sourceName: row.source_name, chars: row.chars,
  chunkCount: row.chunk_count, language: row.language, embeddingStatus: row.embedding_status,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const chunkHit = (row) => row && ({
  chunkId: row.id, documentId: row.document_id, documentTitle: row.document_title, chunkCount: row.chunk_count,
  ordinal: row.ordinal, start: row.start, end: row.end, heading: row.heading, text: row.text,
});

function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.model) {
    throw new LearningError('invalid', `model must be a non-empty string of at most ${LIMITS.model} characters`);
  }
  return value.trim();
}

/** The modes a session can be in; the table's CHECK holds the same list. */
export const SESSION_MODES = ['qa', 'socratic', 'quiz'];

/** The kinds of learning owner other than a single Session (dsbot.mjs). */
export const OWNER_KINDS = ['bot', 'room'];

function ownerKind(value) {
  if (!OWNER_KINDS.includes(value)) throw new LearningError('invalid', `kind must be one of ${OWNER_KINDS.join(', ')}`);
  return value;
}

const ownerRow = (row) => ({
  kind: row.kind, id: row.id, mode: row.mode, updatedAt: row.updated_at, endedAt: row.ended_at ?? null,
});

function sessionKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new LearningError('invalid', 'sessionId must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}

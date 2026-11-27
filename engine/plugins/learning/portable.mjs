// Export, backup and deletion of learning data (M6). Everything here touches only
// `$DSH_HOME/learning/` (the library, its WAL, `exports/`, `backups/`): never DSH's own files,
// ds-bot's data, sessions or the user's skills.
//
// - Export: a folder with notes as Markdown (one folder per notebook) and the rest as JSON
//   (data.json), plus research reports as Markdown, written under learning/exports/ for the
//   app to share or save to Files. data.json can be imported into an empty library again.
// - Backup: a consistent copy of the library file (VACUUM INTO) under learning/backups/.
//   Restore checks the copy's application_id and schema version before anything is replaced,
//   and keeps the current library as a backup first.
// - Delete: removes learning/ whole, after which the library opens empty.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID, LearningError, SCHEMA_VERSION } from './store.mjs';

export const EXPORT_FORMAT = 'dsh-learning-export';
export const EXPORT_VERSION = 1;

/** `YYYY-MM-DD-HH-mm-ss` the app sends: the phone's own clock and time zone. */
export const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

/**
 * The time in a file name: the app's local time when it sent one (the engine on iOS may not
 * know the time zone), else UTC, both as `YYYY-MM-DD-HH-mm-ss`.
 */
export function stamp(now, local) {
  if (typeof local === 'string' && LOCAL_STAMP.test(local)) return local;
  return new Date(now).toISOString().replace(/\..+$/, '').replace(/[T:]/g, '-');
}

/** A file or folder name from a title: no path separators or reserved characters, not empty. */
export function safeName(title, fallback = 'untitled') {
  const name = String(title ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
    .slice(0, 80);
  return name || fallback;
}

function unique(name, used) {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A document's text again, from its overlapping chunks (each chunk is text.slice(start, end)). */
export function documentText(chunks) {
  let text = '';
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    if (chunk.end <= text.length) continue;
    text += chunk.text.slice(Math.max(0, text.length - chunk.start));
  }
  return text;
}

/**
 * Everything in the library as plain data, ids replaced by references within the dump, so
 * two libraries holding the same learning data dump the same.
 */
export function dumpLibrary(store) {
  const db = store.db;
  const notebooks = db.prepare('SELECT * FROM notebooks ORDER BY created_at, id').all();
  const notes = db.prepare('SELECT * FROM notes ORDER BY created_at, id').all();
  const book = new Map(notebooks.map((b, i) => [b.id, i]));
  const docs = db.prepare('SELECT * FROM kb_documents ORDER BY created_at, id').all();
  const chunks = db.prepare('SELECT document_id, start, end, text FROM kb_chunks ORDER BY document_id, ordinal').all();
  const questions = db.prepare('SELECT * FROM quiz_questions ORDER BY created_at, id').all();
  const q = new Map(questions.map((row, i) => [row.id, i]));
  const jobs = db.prepare('SELECT * FROM research_jobs ORDER BY created_at, id').all();
  const settings = store.getSettings();
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    schemaVersion: store.version,
    settings,
    notebooks: notebooks.map((b) => ({ title: b.title, createdAt: b.created_at, updatedAt: b.updated_at })),
    notes: notes.map((n) => ({ notebook: book.get(n.notebook_id), title: n.title, body: n.body, createdAt: n.created_at, updatedAt: n.updated_at })),
    memories: db.prepare('SELECT * FROM memories ORDER BY created_at, id').all()
      .map((m) => ({ content: m.content, source: m.source, createdAt: m.created_at, updatedAt: m.updated_at })),
    sessionModes: db.prepare('SELECT * FROM session_modes ORDER BY session_id').all()
      .map((s) => ({ sessionId: s.session_id, mode: s.mode, updatedAt: s.updated_at, endedAt: s.ended_at ?? null, hidden: Boolean(s.hidden) })),
    // Learning modes of Bots and groups (schema 8); which Session was told what is not kept.
    learningOwners: db.prepare('SELECT * FROM learning_owners ORDER BY kind, id').all()
      .map((o) => ({ kind: o.kind, id: o.id, mode: o.mode, updatedAt: o.updated_at, endedAt: o.ended_at ?? null, hidden: Boolean(o.hidden) })),
    documents: docs.map((d) => ({
      title: d.title, kind: d.kind, sourceName: d.source_name, createdAt: d.created_at,
      text: documentText(chunks.filter((c) => c.document_id === d.id)),
    })),
    questions: questions.map((row) => ({
      kind: row.kind, prompt: row.prompt, options: JSON.parse(row.options), answer: row.answer, explanation: row.explanation,
      topic: row.topic, source: row.source, sessionId: row.session_id ?? null, createdAt: row.created_at,
    })),
    attempts: db.prepare('SELECT * FROM quiz_attempts ORDER BY created_at, id').all().map((a) => ({
      question: q.get(a.question_id), answer: a.answer, verdict: a.verdict, score: a.score, gradedBy: a.graded_by, createdAt: a.created_at,
    })),
    mistakes: db.prepare('SELECT * FROM quiz_mistakes ORDER BY added_at, question_id').all()
      .map((m) => ({ question: q.get(m.question_id), streak: m.streak, addedAt: m.added_at, updatedAt: m.updated_at, dueAt: m.due_at ?? null })),
    // Firefly 伙伴 (schema 10): what the companion lived through and has seen; not the reaches or cursors.
    companionEpisodes: db.prepare('SELECT * FROM companion_episodes ORDER BY happened_at, id').all().map((e) => ({
      botId: e.bot_id, text: e.text, cues: JSON.parse(e.cues), importance: e.importance, emotion: e.emotion, mood: e.mood, key: e.fact_key,
      followUp: e.follow_up, happenedAt: e.happened_at, createdAt: e.created_at, recalls: e.recalls, hidden: Boolean(e.hidden), superseded: e.superseded_by !== null, scope: e.scope ?? 'dm',
    })),
    companionTraits: db.prepare('SELECT * FROM companion_traits ORDER BY bot_id, key').all().map((t) => ({
      botId: t.bot_id, key: t.key, text: t.text, evidence: t.evidence, days: JSON.parse(t.days), firstSeen: t.first_seen, lastSeen: t.last_seen, refuted: Boolean(t.refuted),
    })),
    companionMoods: db.prepare('SELECT * FROM companion_moods ORDER BY at, id').all().map((m) => ({ botId: m.bot_id, word: m.word, valence: m.valence, at: m.at })),
    research: jobs.map((j) => ({
      topic: j.topic, depth: j.depth, sources: JSON.parse(j.sources), status: j.status, report: j.report ?? null, error: j.error ?? null,
      createdAt: j.created_at, updatedAt: j.updated_at,
      claims: db.prepare('SELECT claim, status, note, citations FROM research_claims WHERE job_id = ? ORDER BY rowid').all(j.id)
        .map((c) => ({ claim: c.claim, status: c.status, note: c.note, citations: JSON.parse(c.citations) })),
      citations: db.prepare('SELECT cit_id, tool, query, title, url, label, excerpt, note FROM research_citations WHERE job_id = ? ORDER BY rowid').all(j.id)
        .map((c) => ({ id: c.cit_id, tool: c.tool, query: c.query, title: c.title, url: c.url ?? null, label: c.label ?? null, excerpt: c.excerpt, note: c.note ?? null })),
    })),
  };
}

const TABLES = ['research_claims', 'research_citations', 'research_steps', 'research_blocks', 'research_jobs',
  'quiz_mistakes', 'quiz_attempts', 'quiz_questions', 'kb_vectors', 'kb_chunks', 'kb_documents',
  'learning_owner_sessions', 'learning_owners', 'session_modes', 'notes', 'notebooks', 'memories',
  'companion_episodes', 'companion_traits', 'companion_moods', 'companion_reaches', 'companion_cursors'];

/** Whether the library holds any learning data (settings do not count). */
export function isEmpty(store) {
  return TABLES.every((table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 0);
}

/**
 * Put an export's data.json into an empty library, in one transaction. Documents are
 * chunked again (vectors are made again by the app or the engine); research comes back as
 * finished jobs with their report, claim checks and sources, not their working steps.
 */
export function importLibrary(store, data) {
  if (data?.format !== EXPORT_FORMAT || !Number.isInteger(data.version)) throw new LearningError('invalid', 'this is not a learning export');
  if (data.version > EXPORT_VERSION) throw new LearningError('conflict', `the export is format ${data.version}, newer than this app's ${EXPORT_VERSION}`);
  if (!isEmpty(store)) throw new LearningError('conflict', 'the learning library is not empty; delete the learning data first or restore a backup');
  const list = (value) => (Array.isArray(value) ? value : []);
  const db = store.db;
  return store.transaction(() => {
    if (data.settings) {
      const known = Object.fromEntries(Object.entries(data.settings).filter(([key, value]) => ['injectMemories', 'appleEmbedding', 'researchWeb'].includes(key) && typeof value === 'boolean'));
      if (Object.keys(known).length) store.updateSettings(known);
    }
    const books = list(data.notebooks).map((b) => Number(db.prepare('INSERT INTO notebooks(title, created_at, updated_at) VALUES (?, ?, ?)')
      .run(String(b.title).slice(0, 200), b.createdAt, b.updatedAt).lastInsertRowid));
    for (const n of list(data.notes)) {
      if (books[n.notebook] === undefined) throw new LearningError('invalid', 'a note refers to a notebook that is not in the export');
      db.prepare('INSERT INTO notes(notebook_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(books[n.notebook], n.title ?? '', n.body ?? '', n.createdAt, n.updatedAt);
    }
    for (const m of list(data.memories)) {
      db.prepare('INSERT INTO memories(content, source, created_at, updated_at) VALUES (?, ?, ?, ?)').run(m.content, m.source === 'agent' ? 'agent' : 'user', m.createdAt, m.updatedAt);
    }
    for (const s of list(data.sessionModes)) {
      db.prepare('INSERT INTO session_modes(session_id, mode, updated_at, ended_at, hidden) VALUES (?, ?, ?, ?, ?)')
        .run(s.sessionId, s.mode, s.updatedAt, Number.isInteger(s.endedAt) ? s.endedAt : null, s.hidden === true ? 1 : 0);
    }
    for (const o of list(data.learningOwners)) {
      db.prepare('INSERT INTO learning_owners(kind, id, mode, updated_at, ended_at, hidden) VALUES (?, ?, ?, ?, ?, ?)')
        .run(o.kind, o.id, o.mode, o.updatedAt, Number.isInteger(o.endedAt) ? o.endedAt : null, o.hidden === true ? 1 : 0);
    }
    for (const d of list(data.documents)) {
      const doc = store.importDocument({ title: d.title, kind: d.kind, text: d.text, sourceName: d.sourceName ?? '' });
      db.prepare('UPDATE kb_documents SET created_at = ?, updated_at = ? WHERE id = ?').run(d.createdAt, d.createdAt, doc.id);
    }
    const questions = list(data.questions).map((row) => Number(db.prepare(`
      INSERT INTO quiz_questions(kind, prompt, options, answer, explanation, topic, source, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.kind, row.prompt, JSON.stringify(row.options ?? []), row.answer, row.explanation ?? '', row.topic ?? '', row.source, row.sessionId ?? null, row.createdAt).lastInsertRowid));
    for (const a of list(data.attempts)) {
      db.prepare('INSERT INTO quiz_attempts(question_id, answer, verdict, score, graded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(questions[a.question], a.answer, a.verdict, a.score, a.gradedBy, a.createdAt);
    }
    for (const m of list(data.mistakes)) {
      // An export from before review dates (schema 9): due at once.
      db.prepare('INSERT INTO quiz_mistakes(question_id, streak, added_at, updated_at, due_at) VALUES (?, ?, ?, ?, ?)')
        .run(questions[m.question], m.streak, m.addedAt, m.updatedAt, Number.isInteger(m.dueAt) ? m.dueAt : m.updatedAt);
    }
    for (const e of list(data.companionEpisodes)) {
      // A superseded one comes back hidden: which one replaced it is not kept.
      db.prepare(`INSERT INTO companion_episodes(bot_id, text, cues, importance, emotion, mood, fact_key, follow_up, happened_at, created_at, recalls, hidden, scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(e.botId), String(e.text), JSON.stringify(Array.isArray(e.cues) ? e.cues : []),
        Number(e.importance ?? 0.5), Number(e.emotion ?? 0.3), String(e.mood ?? ''), String(e.key ?? ''), String(e.followUp ?? ''),
        e.happenedAt, e.createdAt ?? e.happenedAt, Number.isInteger(e.recalls) ? e.recalls : 0, e.hidden === true || e.superseded === true ? 1 : 0,
        typeof e.scope === 'string' && (e.scope === 'dm' || e.scope.startsWith('room:')) ? e.scope : 'dm');
    }
    for (const t of list(data.companionTraits)) {
      db.prepare('INSERT OR REPLACE INTO companion_traits(bot_id, key, text, evidence, days, first_seen, last_seen, refuted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(String(t.botId), String(t.key), String(t.text), String(t.evidence ?? ''), JSON.stringify(Array.isArray(t.days) ? t.days : []), t.firstSeen, t.lastSeen, t.refuted === true ? 1 : 0);
    }
    for (const m of list(data.companionMoods)) {
      db.prepare('INSERT INTO companion_moods(bot_id, word, valence, at) VALUES (?, ?, ?, ?)').run(String(m.botId), String(m.word), Number(m.valence ?? 0), m.at);
    }
    for (const j of list(data.research)) {
      const status = ['done', 'failed', 'cancelled'].includes(j.status) ? j.status : 'cancelled';
      const jobId = Number(db.prepare(`
        INSERT INTO research_jobs(topic, depth, sources, status, phase, report, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(j.topic, j.depth, JSON.stringify(j.sources ?? ['web']), status, status, j.report ?? null, j.error ?? null, j.createdAt, j.updatedAt).lastInsertRowid);
      list(j.claims).forEach((c, i) => db.prepare('INSERT INTO research_claims(job_id, key, claim, status, note, citations) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jobId, `imported:${i + 1}`, c.claim, c.status, c.note ?? '', JSON.stringify(c.citations ?? [])));
      for (const c of list(j.citations)) {
        db.prepare('INSERT INTO research_citations(job_id, cit_id, tool, query, title, url, label, excerpt, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(jobId, c.id, c.tool, c.query, c.title, c.url ?? null, c.label ?? null, c.excerpt, c.note ?? null);
      }
    }
    return { imported: true };
  });
}

/**
 * Write an export folder under `dir/exports/`; returns its path and what it holds. Earlier
 * export folders go first: each is only a copy made to be shared, and the newest one is all
 * the app offers.
 */
export function exportLibrary(store, dir, now = Date.now(), { local } = {}) {
  const data = dumpLibrary(store);
  const exports = path.join(dir, 'exports');
  if (fs.existsSync(exports)) {
    for (const name of fs.readdirSync(exports)) {
      if (name.startsWith('learning-export-')) fs.rmSync(path.join(exports, name), { recursive: true, force: true });
    }
  }
  const root = path.join(exports, `learning-export-${stamp(now, local)}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const used = new Set();
  const notesDir = path.join(root, 'notes');
  data.notebooks.forEach((b, i) => {
    const folder = path.join(notesDir, unique(safeName(b.title, 'notebook'), used));
    fs.mkdirSync(folder, { recursive: true });
    const inBook = new Set();
    for (const n of data.notes.filter((note) => note.notebook === i)) {
      const name = unique(safeName(n.title, 'note'), inBook);
      const head = n.title ? `# ${n.title}\n\n` : '';
      fs.writeFileSync(path.join(folder, `${name}.md`), `${head}${n.body}\n`);
    }
  });
  const researchDir = path.join(root, 'research');
  const reports = data.research.filter((j) => j.report);
  if (reports.length) {
    fs.mkdirSync(researchDir, { recursive: true });
    const names = new Set();
    for (const j of reports) fs.writeFileSync(path.join(researchDir, `${unique(safeName(j.topic, 'research'), names)}.md`), `${j.report}\n`);
  }
  fs.writeFileSync(path.join(root, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'README.md'), [
    '# Learning export', '',
    `Exported ${new Date(now).toISOString()} from the app's learning library (schema ${data.schemaVersion}).`, '',
    '- `notes/`: every notebook as a folder, every note as a Markdown file.',
    '- `research/`: finished research reports.',
    '- `data.json`: everything, including memories, the knowledge base, the question bank and research sources; Settings → Learning → Import reads it back into an empty library.', '',
  ].join('\n'));
  return {
    path: root,
    notebooks: data.notebooks.length, notes: data.notes.length, memories: data.memories.length,
    documents: data.documents.length, questions: data.questions.length, research: data.research.length,
  };
}

/** Read and import `<folder>/data.json` (or a data.json path). */
export function importExport(store, from) {
  const file = fs.statSync(from).isDirectory() ? path.join(from, 'data.json') : from;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new LearningError('invalid', 'the export has no readable data.json'); }
  return importLibrary(store, data);
}

/** The tag of the backup taken just before a restore replaces the library. */
export const BEFORE_RESTORE = 'before-restore';

/**
 * A consistent copy of the library under `dir/backups/`, named
 * `learning-YYYY-MM-DD-HH-mm-ss[-tag][-n].db` (`local`: the app's local time, see stamp()).
 */
export function backupLibrary(store, dir, now = Date.now(), { local, tag } = {}) {
  const folder = path.join(dir, 'backups');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const base = `learning-${stamp(now, local)}${tag ? `-${tag}` : ''}`;
  let file = path.join(folder, `${base}.db`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(folder, `${base}-${n}.db`);
  store.db.prepare('VACUUM INTO ?').run(file);
  const stat = fs.statSync(file);
  return { path: file, name: path.basename(file), bytes: stat.size, createdAt: Math.round(stat.mtimeMs), kind: tag === BEFORE_RESTORE ? BEFORE_RESTORE : 'manual' };
}

/**
 * The backups, newest first by when the file was written (older names are UTC and sort
 * differently from the newer local ones, so the name cannot order them).
 */
export function listBackups(dir) {
  const folder = path.join(dir, 'backups');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(folder, name));
      return {
        name, path: path.join(folder, name), bytes: stat.size, createdAt: Math.round(stat.mtimeMs),
        kind: name.includes(`-${BEFORE_RESTORE}`) ? BEFORE_RESTORE : 'manual',
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/**
 * Delete one backup by its exact name as listBackups() gives it: nothing outside backups/
 * (no paths, no other files) can be named.
 */
export function deleteBackup(dir, name) {
  const wanted = String(name ?? '');
  const found = listBackups(dir).find((b) => b.name === wanted);
  if (!found || path.basename(wanted) !== wanted) throw new LearningError('not-found', `no backup named ${wanted}`);
  fs.rmSync(found.path, { force: true });
  return { deleted: found.name };
}

/** Check a would-be library without changing it: our application_id, a schema we can open. */
export function inspectBackup(file) {
  if (!fs.existsSync(file)) throw new LearningError('not-found', 'no such backup');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const appId = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (appId !== APPLICATION_ID) throw new LearningError('invalid', 'this file is not a learning library backup');
    if (version < 1 || version > SCHEMA_VERSION) throw new LearningError('conflict', `the backup is schema ${version}; this app opens schemas 1 to ${SCHEMA_VERSION}`);
    return { schemaVersion: version };
  } catch (error) {
    if (error instanceof LearningError) throw error;
    throw new LearningError('invalid', 'this file is not a learning library backup');
  } finally {
    db?.close();
  }
}

/**
 * Replace the library with a backup. The caller closes the open library first and reopens it
 * after (which migrates an older backup up). The current library is backed up first.
 * @param {string} libraryFile - the library's path.
 * @param {string} backupFile - a file under backups/ (or anywhere the engine can read).
 * @param {() => object} snapshot - backs the current library up; returns its info.
 */
export function restoreLibrary(libraryFile, backupFile, snapshot) {
  const info = inspectBackup(backupFile);
  const safety = snapshot();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${libraryFile}${suffix}`, { force: true });
  fs.copyFileSync(backupFile, libraryFile);
  return { restored: path.basename(backupFile), schemaVersion: info.schemaVersion, previous: safety?.name ?? null };
}

/** Remove all learning data: the `learning/` folder whole. The caller closes the library first. */
export function deleteLearningData(dir) {
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { deleted: existed };
}

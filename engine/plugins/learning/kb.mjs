// The light knowledge base (M3): documents the learner imports, cut into overlapping
// chunks, searched by keyword and, when the app has supplied vectors, by meaning.
//
// What lives here is plain logic with no I/O: chunking, cosine similarity, rank fusion
// and the citation format. The tables are in store.mjs (schema 4).
//
// Vectors are made outside Node: Apple's NLEmbedding (native/ios-native) or an
// OpenAI-compatible provider whose key stays in the Keychain. The app asks which chunks
// still lack a vector for its model, makes them, and stores them; a search may carry the
// query's vector. So no key ever reaches the engine, and everything here is testable.

/** Chunking defaults (DECISIONS.md D16). Counted in code points. */
export const CHUNKING = { target: 500, max: 800, overlap: 80, min: 40 };

/** Reciprocal-rank-fusion constant (the usual 60). */
export const RRF_K = 60;

const codepoints = (text) => [...text].length;

// A sentence ends at Chinese/Japanese full stops and question/exclamation marks, at ；
// and …, at Western . ! ? ; followed by space or end, and at a line break. The closing
// quote or bracket right after the mark stays with its sentence.
const SENTENCE_END = /([。！？；…]+|[.!?;](?=\s|$))(["'”’」』）)\]]*)\s*|\n+/gu;

/** `text` cut into sentences, each with its start offset (code units) in `text`. */
export function sentences(text) {
  const out = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (text.slice(start, end).trim()) out.push({ text: text.slice(start, end), start });
    start = end;
  }
  if (text.slice(start).trim()) out.push({ text: text.slice(start), start });
  return out;
}

/** A piece longer than `max`: cut at the last space or punctuation before `max`, else hard. */
function hardSplit(piece, max) {
  const out = [];
  let rest = piece.text;
  let at = piece.start;
  while (codepoints(rest) > max) {
    const chars = [...rest];
    let cut = max;
    for (let i = max; i > max / 2; i -= 1) {
      if (/[\s,，、:：]/u.test(chars[i - 1])) { cut = i; break; }
    }
    const head = chars.slice(0, cut).join('');
    out.push({ text: head, start: at });
    at += head.length;
    rest = rest.slice(head.length);
  }
  if (rest.trim()) out.push({ text: rest, start: at });
  return out;
}

/** The Markdown heading path in force at each offset of `text`, for chunk labels. */
function headingsOf(text, markdown) {
  if (!markdown) return [];
  const marks = [];
  const stack = [];
  for (const match of text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t#]*$/gmu)) {
    const level = match[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: match[2].trim() });
    marks.push({ at: match.index, path: stack.map((h) => h.title).join(' › ') });
  }
  return marks;
}

/**
 * Cut `text` into chunks of about `target` code points (never more than `max`), on
 * sentence boundaries, each starting with the last `overlap` code points' worth of whole
 * sentences of the chunk before it. Offsets are code-unit offsets into `text`, so
 * `text.slice(start, end)` is the chunk.
 * @returns {{ ordinal:number, start:number, end:number, text:string, heading:string }[]}
 */
export function chunkText(text, { markdown = false, ...options } = {}) {
  const { target, max, overlap, min } = { ...CHUNKING, ...options };
  const pieces = sentences(text).flatMap((s) => (codepoints(s.text) > max ? hardSplit(s, max) : [s]));
  const heads = headingsOf(text, markdown);
  const headingAt = (offset) => {
    let path = '';
    for (const mark of heads) { if (mark.at <= offset) path = mark.path; else break; }
    return path;
  };
  const chunks = [];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    const start = current[0].start;
    const last = current[current.length - 1];
    const end = last.start + last.text.length;
    chunks.push({ ordinal: chunks.length, start, end, text: text.slice(start, end), heading: headingAt(start) });
  };
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    const length = codepoints(piece.text);
    // A Markdown heading starts a new chunk, so one chunk does not straddle two sections.
    const isHeading = markdown && /^#{1,6}[ \t]/u.test(piece.text.trimStart());
    if (current.length && (size + length > target || (isHeading && size >= min))) {
      flush();
      // Carry whole trailing sentences, up to `overlap` code points, into the next chunk.
      const carried = [];
      let kept = 0;
      for (let j = current.length - 1; j >= 0 && !isHeading; j -= 1) {
        const n = codepoints(current[j].text);
        if (kept + n > overlap || kept + n + length > max) break;
        carried.unshift(current[j]);
        kept += n;
      }
      // Never carry everything: the next chunk must move forward.
      current = carried.length === current.length ? [] : carried;
      size = kept;
    }
    current.push(piece);
    size += length;
  }
  flush();
  // A last chunk that is only overlap plus a scrap goes back into the one before it, if it
  // fits and belongs to the same section.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.heading === prev.heading && codepoints(text.slice(prev.end, last.end)) < min
      && codepoints(text.slice(prev.start, last.end)) <= max) {
      chunks.pop();
      prev.end = last.end;
      prev.text = text.slice(prev.start, prev.end);
    }
  }
  return chunks;
}

/** Cosine similarity of two equal-length vectors; 0 when either is all zeros. */
export function cosine(a, b) {
  if (a.length !== b.length) throw new RangeError(`vectors differ in length (${a.length} and ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A vector as the BLOB stored for it: little-endian float32. */
export function vectorToBlob(vector) {
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const value = Number(vector[i]);
    if (!Number.isFinite(value)) throw new RangeError('a vector holds a value that is not a finite number');
    out[i] = value;
  }
  return new Uint8Array(out.buffer);
}

/** A stored BLOB as a Float32Array. */
export function blobToVector(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength % 4) throw new RangeError('a vector BLOB must be a whole number of float32 values');
  return new Float32Array(bytes.slice().buffer);
}

/**
 * Fuse ranked lists by reciprocal rank: score = Σ 1 / (k + rank), rank from 1. An id in
 * only one list still scores. Ties keep the order of first appearance.
 * @param {Array<Array<string|number>>} lists - ids, best first.
 * @returns {{ id:string|number, score:number }[]}
 */
export function fuseRanks(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** One search hit as the citation an answer carries: document, chunk position and the quoted text. */
export function citationOf(hit, excerptSize = 160) {
  const chars = [...hit.text.replace(/\s+/g, ' ').trim()];
  const excerpt = chars.length > excerptSize ? `${chars.slice(0, excerptSize - 1).join('')}…` : chars.join('');
  return {
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    chunkId: hit.chunkId,
    ordinal: hit.ordinal,
    chunkCount: hit.chunkCount,
    start: hit.start,
    end: hit.end,
    heading: hit.heading || undefined,
    excerpt,
    label: `《${hit.documentTitle}》第 ${hit.ordinal + 1}/${hit.chunkCount} 段${hit.heading ? `（${hit.heading}）` : ''}`,
  };
}

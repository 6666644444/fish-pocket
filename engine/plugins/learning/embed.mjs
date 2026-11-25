// Vectors for the knowledge base, made inside the engine with Apple's sentence embedding
// (NLEmbedding, through the dsh_ios_native addon: native/ios-native caps_nlp.m `nlp.vectors`
// and `nlp.language`). On a desktop there is no addon, `appleEmbedder()` is null, and the
// knowledge base searches by keyword only (or with vectors the app sends: an
// OpenAI-compatible provider whose key stays in the app's Keychain).
//
// Each language has its own embedding, so the model name carries the language and the
// embedding's revision (`apple-nl-sentence/zh-Hans/r1`): vectors of different models are
// never compared. A document's language is detected once, from its first chunks.
import { capabilities, invoke } from '../ios-native/binding.mjs';

export const APPLE_PREFIX = 'apple-nl-sentence/';
/** Texts per native call; the addon takes at most 64. */
export const BATCH = 32;

/**
 * Apple's embedding, or null where the addon (or its `nlp.vectors`) is missing.
 * @param {{ caps?: () => object|null, call?: Function }} [deps] - tests inject fakes.
 */
export function appleEmbedder({ caps = capabilities, call = invoke } = {}) {
  const ops = caps()?.nlp;
  if (!Array.isArray(ops) || !ops.includes('vectors') || !ops.includes('language')) return null;
  return {
    /** The dominant language of `text` (BCP-47), or null. */
    async detect(text) {
      const reply = await call('nlp', 'language', { text: text.slice(0, 4_000) }, 'learning');
      return typeof reply?.language === 'string' && reply.language ? reply.language : null;
    },
    /** `{ available: false }` when the device has no sentence embedding for `language`. */
    async embed(texts, language) {
      const reply = await call('nlp', 'vectors', { texts, ...(language ? { language } : {}) }, 'learning');
      if (!reply?.available) return { available: false, language: reply?.language ?? language ?? null };
      return { available: true, language: reply.language, model: reply.model, dims: reply.dimension, vectors: reply.vectors };
    },
  };
}

/** The language a model name was made for (`apple-nl-sentence/<language>/r<n>`), or null. */
export function modelLanguage(model) {
  const match = /^apple-nl-sentence\/([^/]+)\/r\d+$/.exec(model);
  return match ? match[1] : null;
}

/**
 * Give every chunk that lacks one an Apple vector. Runs document by document; a document
 * whose language has no embedding on this device is marked `unavailable` and skipped from
 * then on, so a turn never waits on work that cannot succeed. Stops early on `signal`.
 * @returns {Promise<{ stored:number, documents:number }>}
 */
export async function embedPending(store, embedder, { signal, batch = BATCH } = {}) {
  let stored = 0;
  let documents = 0;
  for (const document of store.documentsToEmbed(APPLE_PREFIX)) {
    if (signal?.aborted) break;
    documents += 1;
    let { language } = document;
    try {
      if (!language) {
        const sample = store.pendingVectors({ modelPrefix: APPLE_PREFIX, documentId: document.id, limit: 4 })
          .map((chunk) => chunk.text).join('\n');
        language = (await embedder.detect(sample)) ?? '';
        if (!language) { store.setDocumentEmbedding({ id: document.id, status: 'unavailable' }); continue; }
        store.setDocumentEmbedding({ id: document.id, language });
      }
      // A chunk the embedding cannot place (only symbols) gets no vector and is passed over
      // for the rest of this run; it is tried again next time.
      const skipped = new Set();
      for (;;) {
        if (signal?.aborted) break;
        if (skipped.size + batch > 256) { store.setDocumentEmbedding({ id: document.id, status: 'ok' }); break; }
        const chunks = store.pendingVectors({ modelPrefix: APPLE_PREFIX, documentId: document.id, limit: batch + skipped.size })
          .filter((chunk) => !skipped.has(chunk.chunkId)).slice(0, batch);
        if (!chunks.length) { store.setDocumentEmbedding({ id: document.id, status: 'ok' }); break; }
        const made = await embedder.embed(chunks.map((chunk) => chunk.text), language);
        if (!made.available) { store.setDocumentEmbedding({ id: document.id, status: 'unavailable' }); break; }
        const items = [];
        chunks.forEach((chunk, i) => {
          const vector = made.vectors?.[i];
          if (Array.isArray(vector) && vector.length) items.push({ chunkId: chunk.chunkId, vector });
          else skipped.add(chunk.chunkId);
        });
        if (items.length) stored += store.putVectors({ model: made.model, items }).stored;
      }
    } catch (error) {
      store.setDocumentEmbedding({ id: document.id, status: 'failed' });
      throw error;
    }
  }
  return { stored, documents };
}

/**
 * The query's vector for every Apple model that has vectors, for `searchKnowledge`'s
 * `queryVectors`. A model whose language the device lost is left out.
 */
export async function appleQueryVectors(store, embedder, query) {
  const out = [];
  for (const { model } of store.vectorModels()) {
    const language = modelLanguage(model);
    if (!language) continue;
    const made = await embedder.embed([query], language);
    if (made.available && made.model === model && Array.isArray(made.vectors?.[0])) out.push({ model, vector: made.vectors[0] });
  }
  return out;
}

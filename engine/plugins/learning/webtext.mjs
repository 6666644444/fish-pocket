// Pages for Deep Research (research-tool.mjs): the text of a fetched page, and pages DSH's
// fetch cannot decode.
//
// Many Chinese sites (exam boards, schools, newspapers) are GBK / GB2312 / GB18030.
// dsh-web-fetch-http refuses a charset its TextDecoder does not know ("unsupported charset")
// and reads a page that names its charset only in a <meta> tag as UTF-8, which garbles it;
// either way research saw no more than the search result's title. Here such a page is read
// once more and decoded as GB18030 (a superset of GBK and GB2312) or Big5. NodeMobile has a
// small ICU without these decoders, so GBK comes with a table of its own (gbk-table.mjs, the
// two-byte codes; the rare four-byte GB18030 codes become U+FFFD); Big5 is read only where
// Node has it. The second read keeps to what DSH allows: http(s) only, the same URL DSH
// accepted, same-origin redirects only, a byte cap and a timeout.
import { GBK_TABLE_BASE64, GBK_TRAILS_PER_LEAD } from './gbk-table.mjs';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', middot: '\u00b7', bull: '\u2022', times: '\u00d7', divide: '\u00f7', copy: '\u00a9', reg: '\u00ae',
};

function entity(match, name) {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  }
  return ENTITIES[name.toLowerCase()] ?? match;
}

/** The page's <title>, or ''. */
export function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html ?? ''));
  return match ? match[1].replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity).replace(/\s+/g, ' ').trim() : '';
}

/**
 * The readable text of an HTML page: scripts, styles, navigation, footers and forms
 * dropped (on Chinese portals they are often most of the page), block ends as line
 * breaks, entities decoded, runs of white space folded.
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form|select|button|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|dd|dt)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity)
    .replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

/** Charset labels DSH cannot decode that this module tries, and the decoder each is read with. */
const LEGACY = {
  gbk: 'gb18030', gb2312: 'gb18030', gb18030: 'gb18030', 'x-gbk': 'gb18030', cp936: 'gb18030', 'gb_2312-80': 'gb18030',
  big5: 'big5', 'big5-hkscs': 'big5', 'x-x-big5': 'big5',
};

/** A legacy Chinese charset label, lower-cased, or undefined. */
export function legacyCharset(label) {
  const name = String(label ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  return Object.hasOwn(LEGACY, name) ? name : undefined;
}

/** The charset a page names in a <meta> tag (only its head is looked at). */
export function metaCharset(html) {
  const head = String(html ?? '').slice(0, 4_096);
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
}

/** The charset DSH refused, from its "unsupported charset" error. */
export function refusedCharset(error) {
  return legacyCharset(/unsupported charset "([^"]+)"/i.exec(String(error?.message ?? ''))?.[1]);
}

let gbkUnits;
/** The bundled GBK table, decoded on first use (~47 KB). */
function gbkTable() {
  if (!gbkUnits) {
    const bytes = Uint8Array.from(atob(GBK_TABLE_BASE64), (c) => c.charCodeAt(0));
    gbkUnits = new Uint16Array(bytes.length / 2);
    for (let i = 0; i < gbkUnits.length; i += 1) gbkUnits[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  }
  return gbkUnits;
}

/**
 * GBK / GB2312 / GB18030 bytes as text, from the bundled table: ASCII as it is, 0x80 the euro
 * sign, a two-byte code from the table, a four-byte GB18030 code (second byte 0x30-0x39) and
 * anything malformed as U+FFFD.
 */
export function decodeGbk(bytes) {
  const table = gbkTable();
  const out = [];
  let chunk = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { chunk += String.fromCharCode(b); i += 1; }
    else if (b === 0x80) { chunk += '\u20AC'; i += 1; }
    else if (b === 0xff || i + 1 >= bytes.length) { chunk += '\uFFFD'; i += 1; }
    else {
      const t = bytes[i + 1];
      if (t >= 0x30 && t <= 0x39) {
        chunk += '\uFFFD';
        i += i + 3 < bytes.length ? 4 : 2;
      } else if (t >= 0x40 && t <= 0xfe && t !== 0x7f) {
        chunk += String.fromCharCode(table[(b - 0x81) * GBK_TRAILS_PER_LEAD + (t < 0x7f ? t - 0x40 : t - 0x41)]);
        i += 2;
      } else {
        chunk += '\uFFFD';
        i += 1;
      }
    }
    if (chunk.length >= 4_096) { out.push(chunk); chunk = ''; }
  }
  out.push(chunk);
  return out.join('');
}

/** A decoder for `charset`: this Node's own, else the bundled GBK table; null when neither. */
export function legacyDecoder(charset) {
  const label = LEGACY[legacyCharset(charset) ?? ''];
  if (!label) return null;
  try { return new TextDecoder(label); } catch { /* small ICU, as on NodeMobile */ }
  return label === 'gb18030' ? { decode: decodeGbk } : null;
}

/** Whether this Node has a GBK decoder of its own (the simulator check reports it). */
export function nativeGbk() {
  try { new TextDecoder('gb18030'); return true; } catch { return false; }
}

/** Whether GBK pages can be read: always, with the bundled table. */
export function canDecodeGbk() {
  return legacyDecoder('gbk') !== null;
}

/**
 * Read `url` again and decode it as `charset`. Returns the decoded body and the final URL,
 * or null when this Node cannot decode it, the page moved to another origin, or it is not
 * a page. Throws on a network error or a non-2xx answer.
 */
export async function fetchLegacy(url, charset, { signal, fetchImpl = globalThis.fetch, maxBytes = 3_000_000, timeoutMs = 20_000, maxRedirects = 3 } = {}) {
  const decoder = legacyDecoder(charset);
  if (!decoder || typeof fetchImpl !== 'function') return null;
  let current = new URL(url);
  if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  const combined = AbortSignal.any(signals);
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current.href, { redirect: 'manual', signal: combined, headers: { accept: 'text/html, text/plain;q=0.9' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (!location || hop >= maxRedirects) return null;
      const next = new URL(location, current);
      if (next.origin !== current.origin) return null;
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`HTTP ${response.status}`);
    }
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type && !/^text\/(html|plain)|^application\/xhtml\+xml/.test(type)) {
      await response.body?.cancel?.();
      return null;
    }
    const chunks = [];
    let size = 0;
    const reader = response.body?.getReader?.();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); break; }
        chunks.push(value);
      }
    } else {
      chunks.push(new Uint8Array(await response.arrayBuffer()));
    }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    return { url: current.href, html: !type.startsWith('text/plain'), content: decoder.decode(bytes) };
  }
}

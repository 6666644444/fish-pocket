// What a model tool returns crosses DSH's Remote boundary, which takes only lossless JSON
// (dsh-typert-protocol isRemoteJsonValue): no `undefined` anywhere (a field left out is
// fine, a field set to undefined is not), no NaN, infinities or -0, no Dates or class
// instances. A value that breaks this fails the whole tool call ("value is not lossless
// JSON"), after the tool already did its work. So every tool result goes through plain().

/** `value` as plain JSON: undefined fields dropped, odd numbers made null or 0. */
export function plain(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
}

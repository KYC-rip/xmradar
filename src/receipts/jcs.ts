/**
 * Strict JSON and RFC 8785 (JCS) for NKIP-0001 receipts, manifests and attestations.
 *
 * Pages are untrusted, so the parser refuses what JSON.parse would quietly accept: duplicate keys
 * (JSON.parse keeps the last), non-integer or unsafe numbers, and trailing content. Only the value
 * types NKIP-0001 uses exist here: null, booleans, strings, safe integers, arrays and objects.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MAX_DEPTH = 16;

export function parseStrict(text: string): Json {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`Bad JSON at ${i}: ${why}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const str = (): string => {
    // the quoted span, decoded by JSON.parse itself once it's known to be a well-formed string
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) fail('control character in string');
      i++;
    }
    if (text[i] !== '"') fail('unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) fail('too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: { [k: string]: Json } = Object.create(null);
      ws();
      if (text[i] === '}') return i++, { ...out };
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected key');
        const k = str();
        if (Object.prototype.hasOwnProperty.call(out, k)) fail(`duplicate key "${k}"`);
        ws();
        if (text[i++] !== ':') fail('expected ":"');
        out[k] = value(depth + 1);
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return i++, { ...out };
        else fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const out: Json[] = [];
      ws();
      if (text[i] === ']') return i++, out;
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return i++, out;
        else fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(lit, i)) return (i += lit.length), v;
    }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('unexpected character');
    // RFC 8785 reads numbers by value: 1.0 and 1e3 are the integers 1 and 1000; 1.5 isn't an integer
    const n = Number(m![0]);
    if (!Number.isInteger(n)) fail('only integers are allowed');
    if (!Number.isSafeInteger(n)) fail('integer out of range');
    i += m![0].length;
    return n;
  };
  const out = value(0);
  ws();
  if (i !== text.length) fail('trailing content');
  return out;
}

/** RFC 8785 for the types above: keys sorted by UTF-16 code units, strings escaped as JSON.stringify does. */
export function canonicalize(v: Json): string {
  if (v === null || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('Only safe integers can be canonicalized');
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  // default sort compares UTF-16 code units, which is what RFC 8785 asks for
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(v[k]!)}`)
    .join(',')}}`;
}

/** The JCS of an object without the named field (what a signature covers). */
export const canonicalWithout = (o: { [k: string]: Json }, field: string): string => {
  const { [field]: _omit, ...rest } = o;
  return canonicalize(rest);
};

/**
 * Tiny JSON → CBOR encoder used to bridge LLM tool-call arguments
 * (JSON strings) into the dCBOR bytes that ACT components expect.
 *
 * Covers the values typically produced by LLM function-calling:
 * objects, arrays, strings, numbers (int/float), booleans, null.
 * Major types per RFC 8949. Not deterministic / canonical — sufficient
 * for tool-call args, not for content addressing.
 */

export function encodeCbor(value: unknown): Uint8Array {
  const chunks: number[] = [];
  write(chunks, value);
  return new Uint8Array(chunks);
}

function write(out: number[], value: unknown): void {
  if (value === null || value === undefined) {
    out.push(0xf6);
    return;
  }
  if (value === true) return out.push(0xf5) as unknown as void;
  if (value === false) return out.push(0xf4) as unknown as void;

  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      writeHead(out, 0, value);
    } else if (Number.isInteger(value) && value < 0 && value >= -0x100000000) {
      writeHead(out, 1, -1 - value);
    } else {
      // float64
      out.push(0xfb);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, value, false);
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < 8; i++) out.push(bytes[i]!);
    }
    return;
  }

  if (typeof value === 'string') {
    const utf8 = new TextEncoder().encode(value);
    writeHead(out, 3, utf8.length);
    for (let i = 0; i < utf8.length; i++) out.push(utf8[i]!);
    return;
  }

  if (Array.isArray(value)) {
    writeHead(out, 4, value.length);
    for (const v of value) write(out, v);
    return;
  }

  if (value instanceof Uint8Array) {
    writeHead(out, 2, value.length);
    for (let i = 0; i < value.length; i++) out.push(value[i]!);
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    writeHead(out, 5, keys.length);
    for (const k of keys) {
      write(out, k);
      write(out, obj[k]);
    }
    return;
  }

  throw new Error('cbor: unsupported value ' + typeof value);
}

function writeHead(out: number[], majorType: number, n: number): void {
  const mt = majorType << 5;
  if (n < 24) {
    out.push(mt | n);
  } else if (n <= 0xff) {
    out.push(mt | 24, n);
  } else if (n <= 0xffff) {
    out.push(mt | 25, (n >> 8) & 0xff, n & 0xff);
  } else if (n <= 0xffffffff) {
    out.push(mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  } else {
    throw new Error('cbor: head too large');
  }
}

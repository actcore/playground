/**
 * Encodes LLM tool-call arguments (JSON values) into the dCBOR bytes that
 * ACT components expect on the wire (ACT-SPEC: arguments are dCBOR, RFC 8949).
 *
 * Backed by the `cbor2` library. The `dcbor` profile gives deterministic,
 * canonical output (sorted keys, NFC strings, preferred number forms) — a
 * strict superset of what tool-call args ever need, and aligned with ACT's
 * dCBOR wire format.
 */

import { encode } from 'cbor2';

export function encodeCbor(value: unknown): Uint8Array {
  return encode(value, { dcbor: true });
}

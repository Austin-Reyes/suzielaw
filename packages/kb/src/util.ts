/**
 * pgvector accepts vector literals in the textual form `[1,2,3]`. We pass
 * embeddings as text + an explicit `::vector(D)` cast so Postgres validates
 * dimension at insert time AND at query time — defence in depth on top of
 * the column's `vector(1536)` type.
 */
export function toVectorLiteral(v: readonly number[]): string {
  // No spaces — pgvector parses the raw form fastest. Reject NaN early so
  // the failure mode is "bad row at app boundary" not "bad row in index".
  let out = '[';
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (!Number.isFinite(n as number)) {
      throw new Error(`Embedding contains non-finite value at index ${i}`);
    }
    if (i > 0) out += ',';
    out += String(n);
  }
  out += ']';
  return out;
}

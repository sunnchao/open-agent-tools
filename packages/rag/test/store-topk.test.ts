import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SqliteVectorStore } from "../src/store.js";
import { cosine, deserializeF32 } from "../src/utils.js";

function fixture(
  t: TestContext,
  options: { vectorScanBatchSize?: number; vectorScanEagerRowLimit?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "rag-topk-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteVectorStore({ dbPath, ...options });
  const db = new DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, db };
}

/** The previous full-sort algorithm, reading the same candidates in SQLite's query order. */
function originalSearch(
  db: DatabaseSync,
  embedding: number[],
  k: number,
  sources?: readonly string[],
) {
  if (sources?.length === 0) return [];
  const filter = sources ? ` AND source IN (${sources.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT rowid, id, source, chunk_index, content, embedding FROM chunks
         WHERE embedding IS NOT NULL${filter}`,
    )
    .all(...(sources ?? []));
  const query = Float32Array.from(embedding);
  return rows
    .map((row) => ({
      id: row.id,
      source: row.source,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: cosine(query, deserializeF32(row.embedding as Uint8Array)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

test("Top-K matches full sort for source filters, ties, negative scores and legacy limits", (t) => {
  const { store, db } = fixture(t);
  let seed = 123;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 0) / 2 ** 32) * 2 - 1;
  };
  for (let i = 0; i < 257; i++) {
    const vector =
      i % 9 === 0
        ? [1, 0, 0]
        : i % 7 === 0
          ? [0, 0, 0]
          : Array.from({ length: (i % 4) + 1 }, random);
    store.insert(
      { id: String(i), source: i % 2 ? "z.txt" : "a.txt", chunkIndex: i, content: `content ${i}` },
      Float32Array.from(vector),
    );
  }
  // Chunks without embeddings must remain absent from vector search.
  store.insert(
    { id: "no-vector", source: "a.txt", chunkIndex: 258, content: "keyword only" },
    new Float32Array(),
  );
  const filters = [
    undefined,
    [],
    ["z.txt"],
    ["z.txt", "a.txt"],
    ["a.txt", "z.txt", "a.txt"],
    ["missing"],
  ];
  for (const query of [[1, 0, 0], [0, 0, 0], [], [0.2, -0.5, 1.2], [1, -1]]) {
    for (const sources of filters) {
      for (const k of [
        0,
        1,
        2,
        8,
        30,
        128,
        256,
        257,
        999,
        -1,
        -12,
        1.9,
        NaN,
        Infinity,
        -Infinity,
      ]) {
        assert.deepEqual(
          store.vectorSearch(query, k, sources),
          originalSearch(db, query, k, sources),
          `query=${query}, k=${k}, sources=${sources}`,
        );
      }
    }
  }
});

test("Top-K keeps the earliest query hits when better scores replace tied heap entries", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 20; i++)
    store.insert(
      { id: String(i), source: "ties", chunkIndex: i, content: String(i) },
      Float32Array.from(i < 10 ? [0, 1] : [1, 0]),
    );
  assert.deepEqual(
    store.vectorSearch([1, 0], 3).map((hit) => hit.id),
    ["10", "11", "12"],
  );
  assert.deepEqual(
    store.vectorSearch([0, 0], 3).map((hit) => hit.id),
    ["0", "1", "2"],
  );
});

test("batched vector scans preserve filtered and legacy Top-K results", (t) => {
  const { store, db } = fixture(t, {
    vectorScanBatchSize: 3,
    vectorScanEagerRowLimit: 0,
  });
  for (let i = 0; i < 47; i++) {
    const vector = i % 6 === 0 ? [0, 0, 0] : [Math.sin(i), Math.cos(i), (i % 5) - 2];
    store.insert(
      { id: `batched-${i}`, source: i % 3 === 0 ? "a" : "b", chunkIndex: i, content: String(i) },
      Float32Array.from(vector),
    );
  }
  for (const sources of [undefined, ["a"], ["b", "a"], ["missing"]] as const) {
    for (const k of [1, 2, 8, 46, 47, 80, 0, -2, 1.5]) {
      assert.deepEqual(
        store.vectorSearch([0.4, -0.2, 1], k, sources),
        originalSearch(db, [0.4, -0.2, 1], k, sources),
      );
    }
  }
});

test("vector scan batch size rejects values that cannot bound a scan", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rag-batch-size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const vectorScanBatchSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new SqliteVectorStore({ dbPath: join(dir, "invalid.db"), vectorScanBatchSize }),
      RangeError,
    );
  }
  for (const vectorScanEagerRowLimit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new SqliteVectorStore({ dbPath: join(dir, "invalid.db"), vectorScanEagerRowLimit }),
      RangeError,
    );
  }
});

test("non-finite stored or query vectors preserve the original sort behavior", (t) => {
  const { store, db } = fixture(t);
  for (const [i, vector] of [
    [1, 0],
    [NaN, 1],
    [-1, 0],
    [1, 1],
    [Infinity, 0],
    [0, 0],
  ].entries()) {
    store.insert(
      { id: String(i), source: "non-finite", chunkIndex: i, content: String(i) },
      Float32Array.from(vector),
    );
  }
  for (const query of [
    [1, 0],
    [NaN, 1],
    [Infinity, 0],
  ]) {
    for (const k of [1, 3, 10])
      assert.deepEqual(store.vectorSearch(query, k), originalSearch(db, query, k));
  }
});

test("malformed embedding blobs still surface decoding errors", (t) => {
  const { store, db } = fixture(t);
  store.insert(
    { id: "valid", source: "bad", chunkIndex: 0, content: "valid" },
    Float32Array.from([1, 0]),
  );
  store.insert(
    { id: "broken", source: "bad", chunkIndex: 1, content: "broken" },
    Float32Array.from([0, 1]),
  );
  db.prepare("UPDATE chunks SET embedding = ? WHERE id = 'broken'").run(new Uint8Array([1]));
  assert.throws(() => store.vectorSearch([1, 0], 1), RangeError);
  assert.throws(() => store.vectorSearch([1, 0], 0), RangeError);
});

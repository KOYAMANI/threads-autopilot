/**
 * D1 の薄いラッパ（SPEC §2.2 / §8.1）。ORM は使わない。
 * 全クエリで budget.dbQueries.use() を呼び、1呼び出しあたりのクエリ数を数える。
 */
import type { Budget } from "./budget";

export type Db = {
  /** 1行返す（無ければ null）。 */
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  /** 全行返す。 */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE。changes と last_row_id を返す。 */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastRowId: number | null }>;
  /** 複数文をまとめて投げる。クエリ数は文の本数ぶん数える。 */
  batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  /** 使ったクエリ数（デバッグ用）。 */
  readonly queryCount: number;
  readonly raw: D1Database;
};

export function createDb(d1: D1Database, budget: Budget): Db {
  let queryCount = 0;

  const spend = (n = 1) => {
    queryCount += n;
    budget.dbQueries.use(n);
  };

  const bind = (sql: string, params: unknown[]) => {
    const stmt = d1.prepare(sql);
    return params.length ? stmt.bind(...(params as never[])) : stmt;
  };

  return {
    async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      spend();
      const row = await bind(sql, params).first<T>();
      return (row ?? null) as T | null;
    },

    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      spend();
      const res = await bind(sql, params).all<T>();
      return res.results ?? [];
    },

    async run(sql: string, ...params: unknown[]) {
      spend();
      const res = await bind(sql, params).run();
      return {
        changes: res.meta?.changes ?? 0,
        lastRowId: res.meta?.last_row_id ?? null,
      };
    },

    async batch(statements) {
      if (statements.length === 0) return;
      spend(statements.length);
      await d1.batch(statements.map((s) => bind(s.sql, s.params ?? [])));
    },

    get queryCount() {
      return queryCount;
    },

    get raw() {
      return d1;
    },
  };
}

/**
 * マルチVALUES の upsert を組み立てる（SPEC §8.1「ループ内で1行ずつ書かない」）。
 * 1クエリ 50 行までにまとめ、chunk ごとの {sql, params} を返す。
 */
export function buildUpsertChunks(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictColumns: string[],
  updateColumns: string[],
  chunkSize = 50,
): Array<{ sql: string; params: unknown[] }> {
  const out: Array<{ sql: string; params: unknown[] }> = [];
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql =
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ` +
      chunk.map(() => placeholders).join(",") +
      ` ON CONFLICT(${conflictColumns.join(",")}) DO ` +
      (updateColumns.length
        ? `UPDATE SET ${updateColumns.map((c) => `${c}=excluded.${c}`).join(",")}`
        : "NOTHING");
    out.push({ sql, params: chunk.flat() });
  }
  return out;
}

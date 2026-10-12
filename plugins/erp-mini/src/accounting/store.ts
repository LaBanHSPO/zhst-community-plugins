export type SqlParameter = string | number | bigint | null | Uint8Array;
export interface WriteResult { changes: number; lastInsertRowid: number | bigint }

/** One host-owned connection; no asynchronous work inside a financial transaction. */
export interface AccountingStore {
  get<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T[];
  run(sql: string, ...parameters: SqlParameter[]): WriteResult;
  transaction<T>(work: () => T): T;
  close(): void;
}

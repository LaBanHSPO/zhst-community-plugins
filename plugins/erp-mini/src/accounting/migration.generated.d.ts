/** Build-time artifact; its implementation contains data only, never Node imports. */
export declare const accountingMigrations: readonly {
  readonly version: 1 | 2;
  readonly sql: string;
  readonly checksum: string;
  readonly schema: readonly { type: string; name: string; tbl_name: string; sql: string }[];
}[];

declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string);
    exec(sql: string): void;
    run(sql: string, ...params: unknown[]): unknown;
    query(sql: string): {
      get(...params: unknown[]): unknown;
    };
    close(): void;
  }
}

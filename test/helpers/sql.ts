import { vi } from "vitest";

/**
 * Test helper: mock the @/lib/db module. The mocked `sql` function and
 * `sql.query` can be programmed per test via the returned controller.
 *
 * Usage:
 *   vi.mock("@/lib/db", () => createSqlMock());
 *   const { setSqlResult, calls } = await import("./helpers/sql").then(...);
 */

type Row = Record<string, unknown>;
type Handler = (strings: TemplateStringsArray, values: unknown[]) => Row[] | Promise<Row[]>;
type QueryHandler = (text: string, params: unknown[]) => Row[] | Promise<Row[]>;

export interface SqlMockController {
  setTemplateHandler(fn: Handler): void;
  setQueryHandler(fn: QueryHandler): void;
  templateCalls: Array<{ text: string; values: unknown[] }>;
  queryCalls: Array<{ text: string; params: unknown[] }>;
  reset(): void;
}

export function createSqlController(): SqlMockController {
  let templateHandler: Handler = () => [];
  let queryHandler: QueryHandler = () => [];
  const templateCalls: Array<{ text: string; values: unknown[] }> = [];
  const queryCalls: Array<{ text: string; params: unknown[] }> = [];
  return {
    setTemplateHandler(fn) {
      templateHandler = fn;
    },
    setQueryHandler(fn) {
      queryHandler = fn;
    },
    templateCalls,
    queryCalls,
    reset() {
      templateHandler = () => [];
      queryHandler = () => [];
      templateCalls.length = 0;
      queryCalls.length = 0;
    },
    // Internal — exposed for the mock factory below.
    ...({
      _runTemplate: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = String.raw({ raw: strings }, ...values.map(() => "?"));
        templateCalls.push({ text, values });
        return templateHandler(strings, values);
      },
      _runQuery: async (text: string, params: unknown[] = []) => {
        queryCalls.push({ text, params });
        return queryHandler(text, params);
      },
    } as Record<string, unknown>),
  } as SqlMockController;
}

/**
 * Build a `vi.mock` factory for @/lib/db backed by an SqlMockController.
 * Pass the controller in via the closure.
 */
export function makeDbMockFactory(controller: SqlMockController) {
  return () => {
    const ctrl = controller as unknown as Record<string, (...args: unknown[]) => unknown>;
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        ctrl._runTemplate(strings, ...values),
      {
        query: (text: string, params: unknown[] = []) => ctrl._runQuery(text, params),
      },
    );
    return {
      sql,
      getDb: () => sql,
      getPool: () => {
        const client = {
          query: (text: string, params: unknown[] = []) =>
            ctrl._runQuery(text, params).then((rows) => ({ rows })),
          release: vi.fn(),
        };
        return {
          connect: vi.fn(async () => client),
          query: (text: string, params: unknown[] = []) =>
            ctrl._runQuery(text, params).then((rows) => ({ rows })),
        };
      },
      withTransaction: async <T>(fn: (client: { query: QueryHandler }) => Promise<T>) => {
        const client = {
          query: (text: string, params: unknown[] = []) =>
            ctrl._runQuery(text, params).then((rows) => ({ rows })),
        };
        return fn(client as unknown as { query: QueryHandler });
      },
    };
  };
}

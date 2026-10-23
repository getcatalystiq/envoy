import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth", () => ({ verifyAccessToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  sql: Object.assign(vi.fn(), { query: vi.fn() }),
  withTransaction: vi.fn(),
}));

import { verifyAccessToken } from "@/lib/oauth";
import { sql } from "@/lib/db";
import { POST } from "@/app/mcp/route";

const verifyMock = vi.mocked(verifyAccessToken);
const sqlMock = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn> & {
  query: ReturnType<typeof vi.fn>;
};

function rpc(method: string, params: object, token?: string): Request {
  return new Request("https://envoy.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** Parse the JSON-RPC result out of an SSE or JSON response body. */
async function result(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const json = text.includes("data: ")
    ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)
    : text;
  return JSON.parse(json).result;
}

function tokenFor(scope: string) {
  verifyMock.mockResolvedValue({
    sub: "user-1",
    tenant_id: "org-1",
    client_id: "client-1",
    scope,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/mcp route", () => {
  it("rejects a call with no bearer token", async () => {
    const res = await POST(rpc("tools/list", {}));
    expect(res.status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("rejects a token that fails verification", async () => {
    verifyMock.mockRejectedValue(new Error("bad signature"));
    const res = await POST(rpc("tools/list", {}, "forged"));
    expect(res.status).toBe(401);
  });

  it("lists all 15 tools for an authenticated caller", async () => {
    tokenFor("read");
    const res = await POST(rpc("tools/list", {}, "t"));
    expect(res.status).toBe(200);
    const { tools } = (await result(res)) as { tools: { name: string }[] };
    expect(tools).toHaveLength(15);
    expect(tools.map((t) => t.name)).toContain("search_targets");
  });

  it("passes the token's tenant to the tool's query (auth reaches the handler)", async () => {
    tokenFor("read");
    sqlMock.query.mockResolvedValue([]);
    const res = await POST(
      rpc("tools/call", { name: "search_targets", arguments: {} }, "t"),
    );
    const r = await result(res);
    expect(r.isError).toBeFalsy();
    expect(sqlMock.query).toHaveBeenCalledTimes(1);
    expect(sqlMock.query.mock.calls[0][1][0]).toBe("org-1");
    // `limit` default still applied by the v2 input schema.
    expect(sqlMock.query.mock.calls[0][1].at(-1)).toBe(20);
  });

  it("refuses a write tool for a read-only token, before any query", async () => {
    tokenFor("read");
    const res = await POST(
      rpc(
        "tools/call",
        { name: "create_target", arguments: { email: "a@example.com" } },
        "t",
      ),
    );
    const r = (await result(res)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Insufficient scope/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("runs a write tool for a write-scoped token", async () => {
    tokenFor("read write");
    sqlMock
      .mockResolvedValueOnce([]) // no existing lead
      .mockResolvedValueOnce([{ id: 7, email: "a@example.com", lifecycle_stage: 0 }]);
    const res = await POST(
      rpc(
        "tools/call",
        { name: "create_target", arguments: { email: "a@example.com" } },
        "t",
      ),
    );
    const r = (await result(res)) as { isError?: boolean; structuredContent: { target: { id: string } } };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.target.id).toBe("7");
    // Both the duplicate check and the INSERT are scoped to the token's tenant.
    expect(sqlMock).toHaveBeenCalledTimes(2);
    for (const call of sqlMock.mock.calls) {
      expect(call.slice(1)).toContain("org-1");
    }
  });

  it("rejects invalid tool arguments via the input schema", async () => {
    tokenFor("read write");
    const res = await POST(
      rpc(
        "tools/call",
        { name: "create_target", arguments: { email: "not-an-email" } },
        "t",
      ),
    );
    const text = JSON.stringify(await result(res).catch(() => ({})));
    expect(sqlMock).not.toHaveBeenCalled();
    expect(text).not.toContain("Created new lead");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  renderBroadcast,
  sendBroadcast,
  BroadcastRenderError,
} from "@sdk/broadcast/render.js";
import {
  getTemplate,
  clearTemplateCache,
  TemplateFetchError,
} from "@sdk/resend/templates.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";

// --- Resend mock --------------------------------------------------------------------------------
// A hand-rolled ResendClientHandle exposing only `templates.get` and `broadcasts.create`, both
// returning Resend's `{ data, error }` shape. Mirrors the casting idiom in broadcast/claim.test.ts.

type ResendTemplate = {
  id: string;
  html: string;
  text: string | null;
  variables:
    | { key: string; fallback_value: string | number | null; type: "string" | "number" }[]
    | null;
};

function fakeResend(opts?: {
  enabled?: boolean;
  template?: ResendTemplate;
  templateError?: { message?: string } | null;
  createError?: { message?: string } | null;
  createId?: string;
}): {
  handle: ResendClientHandle;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const enabled = opts?.enabled ?? true;

  const get = vi.fn(async (_id: string) => ({
    data: opts?.templateError ? null : (opts?.template ?? null),
    error: opts?.templateError ?? null,
  }));

  const create = vi.fn(async (_payload: Record<string, unknown>) => ({
    data: opts?.createError ? null : { id: opts?.createId ?? "bcast_1" },
    error: opts?.createError ?? null,
  }));

  const fakeClient = { templates: { get }, broadcasts: { create } };

  const handle: ResendClientHandle = {
    enabled,
    client: () => (enabled ? (fakeClient as never) : null),
  };

  return { handle, get, create };
}

function tmpl(overrides?: Partial<ResendTemplate>): ResendTemplate {
  return {
    id: "tmpl_123",
    html: "<p>Hello {{ first_name }}, your plan is {{plan}}.</p>",
    text: "Hello {{ first_name }}, your plan is {{plan}}.",
    variables: [
      { key: "first_name", fallback_value: "friend", type: "string" },
      { key: "plan", fallback_value: null, type: "string" },
    ],
    ...overrides,
  };
}

afterEach(() => {
  clearTemplateCache();
  vi.restoreAllMocks();
});

// --- getTemplate --------------------------------------------------------------------------------

describe("getTemplate", () => {
  it("fetches and normalizes html/text/variables", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    const fetched = await getTemplate(handle, "tmpl_123");

    expect(fetched.id).toBe("tmpl_123");
    expect(fetched.html).toContain("Hello {{ first_name }}");
    expect(fetched.text).toContain("your plan is {{plan}}");
    expect(fetched.variables).toHaveLength(2);
    expect(fetched.variables[0]).toEqual({ key: "first_name", fallback: "friend", type: "string" });
    expect(fetched.variables[1]).toEqual({ key: "plan", fallback: null, type: "string" });
  });

  it("caches by id — a second get does NOT re-fetch", async () => {
    const { handle, get } = fakeResend({ template: tmpl() });

    await getTemplate(handle, "tmpl_123");
    await getTemplate(handle, "tmpl_123");

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refresh:true forces a re-fetch", async () => {
    const { handle, get } = fakeResend({ template: tmpl() });

    await getTemplate(handle, "tmpl_123");
    await getTemplate(handle, "tmpl_123", { refresh: true });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("normalizes a null variables array to an empty list", async () => {
    const { handle } = fakeResend({ template: tmpl({ variables: null }) });
    const fetched = await getTemplate(handle, "tmpl_123");
    expect(fetched.variables).toEqual([]);
  });

  it("normalizes a null text part to null", async () => {
    const { handle } = fakeResend({ template: tmpl({ text: null }) });
    const fetched = await getTemplate(handle, "tmpl_123");
    expect(fetched.text).toBeNull();
  });

  it("fails loud when Resend is unset (no no-op)", async () => {
    const { handle, get } = fakeResend({ enabled: false, template: tmpl() });
    await expect(getTemplate(handle, "tmpl_123")).rejects.toBeInstanceOf(TemplateFetchError);
    expect(get).not.toHaveBeenCalled();
  });

  it("fails loud on an upstream error", async () => {
    const { handle } = fakeResend({ templateError: { message: "boom" } });
    await expect(getTemplate(handle, "tmpl_123")).rejects.toThrow(/boom/);
  });

  it("fails loud on a missing template (data null, no error)", async () => {
    const { handle } = fakeResend({ template: undefined });
    await expect(getTemplate(handle, "tmpl_404")).rejects.toThrow(/templates\.get failed/);
  });

  it("rejects an empty id", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    await expect(getTemplate(handle, "")).rejects.toBeInstanceOf(TemplateFetchError);
  });
});

// --- renderBroadcast ----------------------------------------------------------------------------

describe("renderBroadcast", () => {
  it("fills declared variables and leaves Resend merge tags verbatim (R32 happy)", async () => {
    const { handle } = fakeResend({
      template: tmpl({
        html:
          "<p>Hi {{ first_name }} — {{{FIRST_NAME|there}}}. Plan {{plan}}. " +
          "<a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\">unsub</a></p>",
        text: null,
      }),
    });

    const out = await renderBroadcast(handle, {
      templateId: "tmpl_123",
      variables: { first_name: "Marko", plan: "Pro" },
    });

    // Declared {{ key }} variables filled.
    expect(out.html).toContain("Hi Marko");
    expect(out.html).toContain("Plan Pro");
    // Resend {{{...}}} merge tags preserved verbatim — never rewritten by the SDK.
    expect(out.html).toContain("{{{FIRST_NAME|there}}}");
    expect(out.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
  });

  it("uses the Template fallback when a variable value is missing", async () => {
    const { handle } = fakeResend({ template: tmpl({ text: null }) });
    const out = await renderBroadcast(handle, { templateId: "tmpl_123", variables: { plan: "Pro" } });
    // first_name not supplied → Template fallback "friend".
    expect(out.html).toContain("Hello friend");
    expect(out.html).toContain("plan is Pro");
  });

  it("substitutes empty string when neither value nor fallback exists", async () => {
    const { handle } = fakeResend({ template: tmpl({ text: null }) });
    // plan has fallback null and no supplied value → empty.
    const out = await renderBroadcast(handle, { templateId: "tmpl_123", variables: { first_name: "X" } });
    expect(out.html).toContain("plan is .");
  });

  it("stringifies number and boolean values", async () => {
    const { handle } = fakeResend({
      template: tmpl({ html: "<p>{{ count }} / {{ flag }}</p>", text: null, variables: [] }),
    });
    const out = await renderBroadcast(handle, {
      templateId: "tmpl_123",
      variables: { count: 7, flag: true },
    });
    expect(out.html).toBe("<p>7 / true</p>");
  });

  it("renders the text part too when present", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    const out = await renderBroadcast(handle, {
      templateId: "tmpl_123",
      variables: { first_name: "A", plan: "B" },
    });
    expect(out.text).toBe("Hello A, your plan is B.");
  });

  it("returns null text when the template has none", async () => {
    const { handle } = fakeResend({ template: tmpl({ text: null }) });
    const out = await renderBroadcast(handle, { templateId: "tmpl_123" });
    expect(out.text).toBeNull();
  });

  it("does not corrupt an unknown declared-looking tag that has no value or fallback", async () => {
    const { handle } = fakeResend({
      template: tmpl({ html: "<p>{{ unknown }}</p>", text: null, variables: [] }),
    });
    const out = await renderBroadcast(handle, { templateId: "tmpl_123" });
    expect(out.html).toBe("<p></p>");
  });

  it("rejects a missing templateId", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    await expect(
      // @ts-expect-error intentionally missing templateId
      renderBroadcast(handle, { variables: {} })
    ).rejects.toBeInstanceOf(BroadcastRenderError);
  });
});

// --- sendBroadcast ------------------------------------------------------------------------------

describe("sendBroadcast", () => {
  it("calls broadcasts.create with segmentId/topicId/html/text/send and NO templateId or headers", async () => {
    const { handle, create } = fakeResend({ template: tmpl(), createId: "bcast_42" });

    const res = await sendBroadcast(handle, {
      templateId: "tmpl_123",
      variables: { first_name: "Marko", plan: "Pro" },
      segmentId: "seg_1",
      topicId: "topic_1",
      from: "news@example.com",
      subject: "June digest",
      name: "june-digest",
    });

    expect(res.broadcastId).toBe("bcast_42");
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]![0] as Record<string, unknown>;

    expect(payload.segmentId).toBe("seg_1");
    expect(payload.topicId).toBe("topic_1");
    expect(payload.from).toBe("news@example.com");
    expect(payload.subject).toBe("June digest");
    expect(payload.name).toBe("june-digest");
    expect(payload.send).toBe(true);
    expect(payload.html).toContain("Hello Marko");
    expect(payload.html).toContain("your plan is Pro");
    // Verified Resend facts: broadcasts.create has NO templateId and NO headers.
    expect(payload).not.toHaveProperty("templateId");
    expect(payload).not.toHaveProperty("headers");
  });

  it("renders merge tags verbatim into the dispatched html", async () => {
    const { handle, create } = fakeResend({
      template: tmpl({
        html: "<p>{{ plan }} <a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\">x</a></p>",
        text: null,
      }),
    });

    await sendBroadcast(handle, {
      templateId: "tmpl_123",
      variables: { plan: "Pro" },
      segmentId: "seg_1",
      topicId: "topic_1",
      from: "news@example.com",
      subject: "s",
    });

    const payload = create.mock.calls[0]![0] as Record<string, string>;
    expect(payload.html).toBe('<p>Pro <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">x</a></p>');
  });

  it("omits text when the template has none", async () => {
    const { handle, create } = fakeResend({ template: tmpl({ text: null }) });
    await sendBroadcast(handle, {
      templateId: "tmpl_123",
      segmentId: "seg_1",
      topicId: "topic_1",
      from: "a@b.com",
      subject: "s",
    });
    const payload = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("text");
  });

  it("passes scheduledAt and send:false through when given", async () => {
    const { handle, create } = fakeResend({ template: tmpl({ text: null }) });
    await sendBroadcast(handle, {
      templateId: "tmpl_123",
      segmentId: "seg_1",
      topicId: "topic_1",
      from: "a@b.com",
      subject: "s",
      send: false,
      scheduledAt: "2026-07-01T09:00:00Z",
    });
    const payload = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.send).toBe(false);
    expect(payload.scheduledAt).toBe("2026-07-01T09:00:00Z");
  });

  it("reuses the cached template across two sends (no re-fetch)", async () => {
    const { handle, get } = fakeResend({ template: tmpl({ text: null }) });
    const base = {
      templateId: "tmpl_123",
      segmentId: "seg_1",
      topicId: "topic_1",
      from: "a@b.com",
      subject: "s",
    };
    await sendBroadcast(handle, base);
    await sendBroadcast(handle, base);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing topicId (the unsubscribe gate is mandatory, KTD9)", async () => {
    const { handle, create } = fakeResend({ template: tmpl() });
    await expect(
      sendBroadcast(handle, {
        templateId: "tmpl_123",
        segmentId: "seg_1",
        topicId: undefined as unknown as string,
        from: "a@b.com",
        subject: "s",
      })
    ).rejects.toBeInstanceOf(BroadcastRenderError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a missing segmentId", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    await expect(
      sendBroadcast(handle, {
        templateId: "tmpl_123",
        segmentId: "",
        topicId: "topic_1",
        from: "a@b.com",
        subject: "s",
      })
    ).rejects.toThrow(/segmentId/);
  });

  it("rejects a missing from", async () => {
    const { handle } = fakeResend({ template: tmpl() });
    await expect(
      sendBroadcast(handle, {
        templateId: "tmpl_123",
        segmentId: "seg_1",
        topicId: "topic_1",
        from: "   ",
        subject: "s",
      })
    ).rejects.toThrow(/from/);
  });

  it("fails loud when broadcasts.create returns an error", async () => {
    const { handle } = fakeResend({ template: tmpl({ text: null }), createError: { message: "rate limited" } });
    await expect(
      sendBroadcast(handle, {
        templateId: "tmpl_123",
        segmentId: "seg_1",
        topicId: "topic_1",
        from: "a@b.com",
        subject: "s",
        name: "k1",
      })
    ).rejects.toThrow(/broadcasts\.create failed for "k1".*rate limited/);
  });

  it("fails loud when Resend is unset", async () => {
    const { handle } = fakeResend({ enabled: false, template: tmpl() });
    await expect(
      sendBroadcast(handle, {
        templateId: "tmpl_123",
        segmentId: "seg_1",
        topicId: "topic_1",
        from: "a@b.com",
        subject: "s",
      })
    ).rejects.toBeInstanceOf(TemplateFetchError);
  });
});

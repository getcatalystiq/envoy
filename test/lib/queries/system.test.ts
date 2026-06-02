import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  const client = { query: vi.fn(), release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
  };
  return {
    sql: Object.assign(sql, { query: vi.fn() }),
    getPool: () => pool,
  };
});

import { sql, getPool } from "@/lib/db";
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

import {
  claimQueuedEmails,
  claimScheduledCampaigns,
  markEmailSent,
  markEmailFailed,
  updateTargetStatusByEmail,
  incrementSoftBounce,
  resetSkippedEnrollments,
  unstickSendingEmails,
} from "@/lib/queries/system";

describe("lib/queries/system", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    const pool = getPool() as { connect: ReturnType<typeof vi.fn> };
    pool.connect.mockClear();
  });

  describe("claimQueuedEmails", () => {
    it("uses FOR UPDATE SKIP LOCKED + CTE for atomic claim", async () => {
      sqlMock.mockResolvedValueOnce([
        { id: "e1", status: "sending", organization_id: "org-1" },
      ]);
      await claimQueuedEmails(50);
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("FOR UPDATE SKIP LOCKED");
      expect(text).toContain("'sending'"); // sets status hardcoded
      expect(text).toContain("processing_started_at = NOW()");
      expect(text).toContain("JOIN organizations");
      expect(values).toContain(50);
    });
  });

  describe("claimScheduledCampaigns", () => {
    it("filters by status='scheduled' + agent_id NOT NULL + reclaim lock", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await claimScheduledCampaigns(5);
      const [strings] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("'scheduled'");
      expect(text).toContain("agent_id IS NOT NULL");
      expect(text).toContain("FOR UPDATE OF c SKIP LOCKED");
      expect(text).toContain("'active'"); // claim transitions to active
      expect(text).toContain("INTERVAL '15 minutes'");
    });

    it("returns agent_id with claimed campaign", async () => {
      sqlMock.mockResolvedValueOnce([
        { id: "c1", organization_id: "org-1", agent_id: "agent-7" },
      ]);
      const rows = await claimScheduledCampaigns(10);
      expect(rows[0].agent_id).toBe("agent-7");
    });
  });

  describe("markEmailSent / markEmailFailed", () => {
    it("markEmailSent sets status='sent' and ses_message_id", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await markEmailSent("e1", "ses-id-1");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE email_sends");
      expect(text).toContain("'sent'");
      expect(text).toContain("sent_at = NOW()");
      expect(values).toContain("ses-id-1");
      expect(values).toContain("e1");
    });

    it("markEmailFailed sets status='failed'", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await markEmailFailed("e1");
      const [strings] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE email_sends");
      expect(text).toContain("'failed'");
    });
  });

  describe("updateTargetStatusByEmail", () => {
    it("updates by email, status='active' only (cross-tenant intentional)", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await updateTargetStatusByEmail("x@y.com", "bounced");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE targets");
      expect(text).toContain("email =");
      expect(text).toContain("status = 'active'");
      expect(values).toContain("bounced");
      expect(values).toContain("x@y.com");
    });
  });

  describe("incrementSoftBounce", () => {
    it("returns new soft_bounce_count from RETURNING clause", async () => {
      sqlMock.mockResolvedValueOnce([{ soft_bounce_count: 3 }]);
      expect(await incrementSoftBounce("x@y.com")).toBe(3);
    });

    it("returns 0 when no row matched", async () => {
      sqlMock.mockResolvedValueOnce([]);
      expect(await incrementSoftBounce("x@y.com")).toBe(0);
    });
  });

  describe("resetSkippedEnrollments", () => {
    it("no-ops on empty array", async () => {
      await resetSkippedEnrollments([]);
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it("UPDATEs next_evaluation_at on all provided enrollment IDs", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await resetSkippedEnrollments(["e1", "e2", "e3"]);
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE sequence_enrollments");
      expect(text).toContain("next_evaluation_at = NOW() + INTERVAL '1 minute'");
      expect(text).toContain("id = ANY");
      expect(values[0]).toEqual(["e1", "e2", "e3"]);
    });
  });

  describe("unstickSendingEmails", () => {
    it("resets stale 'sending' emails after 10 min back to 'queued', returns count", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }]);
      const n = await unstickSendingEmails();
      const [strings] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE email_sends");
      expect(text).toContain("'queued'");
      expect(text).toContain("'sending'");
      expect(text).toContain("INTERVAL '10 minutes'");
      expect(n).toBe(2);
    });
  });
});

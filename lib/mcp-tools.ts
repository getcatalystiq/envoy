import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { sql, withTransaction } from "@/lib/db";
import * as agentplane from "@/lib/agentplane";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extra = RequestHandlerExtra<any, any>;

export const SERVER_INSTRUCTIONS = `You are Envoy, an AI sales and marketing agent. You help users manage leads, campaigns, sequences, and email outreach.

Available capabilities:
- Search and manage leads/targets
- Generate personalized email content via AI
- Manage email campaigns
- View engagement analytics
- Review and approve outbox items
- View sequence enrollment status
- Configure block-level AI personalization`;

const LIFECYCLE_STAGES: Record<number, string> = {
  0: "Unaware",
  1: "Aware",
  2: "Interested",
  3: "Considering",
  4: "Intent",
  5: "Converted",
  6: "Advocate",
};

function getAuth(extra: Extra) {
  const authExtra = (
    extra.authInfo as Record<string, unknown> | undefined
  )?.extra as { userId: string; tenantId: string } | undefined;
  const userId = authExtra?.userId;
  const tenantId = authExtra?.tenantId;
  if (!userId || !tenantId) {
    throw new Error("Authentication required");
  }
  return { userId, tenantId };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

async function getAgentId(orgId: string): Promise<string | null> {
  const rows = await sql`
    SELECT agentplane_agent_id FROM organizations WHERE id = ${orgId}
  `;
  return rows.length > 0 ? rows[0].agentplane_agent_id : null;
}

export function registerTools(server: McpServer) {
  // --- search_targets ---
  server.tool(
    "search_targets",
    "Search for leads/targets. Filter by lifecycle stage, status, or search on name/email.",
    {
      query: z.string().optional().describe("Search query for name or email"),
      lifecycle_stage: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe(
          "0=Unaware, 1=Aware, 2=Interested, 3=Considering, 4=Intent, 5=Converted, 6=Advocate",
        ),
      status: z
        .enum(["active", "unsubscribed", "bounced"])
        .optional(),
      limit: z.number().int().max(100).default(20),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);
      const conditions = ["organization_id = $1"];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (args.status) {
        conditions.push(`status = $${idx}`);
        params.push(args.status);
        idx++;
      }
      if (args.lifecycle_stage !== undefined) {
        conditions.push(`lifecycle_stage = $${idx}`);
        params.push(args.lifecycle_stage);
        idx++;
      }

      const rows = await sql.query(
        `SELECT id, email, first_name, last_name, company, phone, lifecycle_stage, status
         FROM targets
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        [...params, args.limit],
      );

      const formatted = rows.map(
        (t: Record<string, unknown>) => ({
          id: String(t.id),
          email: t.email,
          name:
            [t.first_name, t.last_name].filter(Boolean).join(" ") || null,
          company: t.company,
          phone: t.phone,
          lifecycle_stage: t.lifecycle_stage,
          lifecycle_stage_name:
            LIFECYCLE_STAGES[t.lifecycle_stage as number] ?? "Unknown",
          status: t.status,
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: `Found ${formatted.length} leads matching your search.`,
          },
        ],
        structuredContent: {
          targets: formatted,
          summary: { total: formatted.length },
        },
      };
    },
  );

  // --- create_target ---
  server.tool(
    "create_target",
    "Create a new lead/target.",
    {
      email: z.string().email().describe("Email address (required)"),
      first_name: z.string().optional().describe("First name"),
      last_name: z.string().optional().describe("Last name"),
      company: z.string().optional().describe("Company name"),
      lifecycle_stage: z.number().int().min(0).max(6).default(0),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const existing = await sql`
        SELECT id FROM targets WHERE organization_id = ${tenantId} AND email = ${args.email}
      `;
      if (existing.length > 0) {
        return errorResult(`A lead with email ${args.email} already exists.`);
      }

      const rows = await sql`
        INSERT INTO targets (organization_id, email, first_name, last_name, company, lifecycle_stage)
        VALUES (${tenantId}, ${args.email}, ${args.first_name ?? null}, ${args.last_name ?? null}, ${args.company ?? null}, ${args.lifecycle_stage})
        RETURNING id, email, lifecycle_stage
      `;

      const target = rows[0];
      const name =
        [args.first_name, args.last_name].filter(Boolean).join(" ") ||
        args.email;

      return {
        content: [
          { type: "text", text: `Created new lead: ${name} (${args.email})` },
        ],
        structuredContent: {
          target: {
            id: String(target.id),
            email: target.email,
            name,
            lifecycle_stage: target.lifecycle_stage,
          },
        },
      };
    },
  );

  // --- get_target ---
  server.tool(
    "get_target",
    "Get detailed information about a specific lead by ID.",
    {
      target_id: z.string().uuid().describe("The target/lead ID"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const rows = await sql`
        SELECT * FROM targets WHERE id = ${args.target_id} AND organization_id = ${tenantId}
      `;

      if (rows.length === 0) return errorResult("Target not found.");

      const t = rows[0];
      const name =
        [t.first_name, t.last_name].filter(Boolean).join(" ") || null;

      return {
        content: [
          {
            type: "text",
            text: `Lead: ${name || t.email} - ${LIFECYCLE_STAGES[t.lifecycle_stage as number] ?? "Unknown"}`,
          },
        ],
        structuredContent: {
          target: {
            id: String(t.id),
            email: t.email,
            name,
            first_name: t.first_name,
            last_name: t.last_name,
            company: t.company,
            phone: t.phone,
            lifecycle_stage: t.lifecycle_stage,
            lifecycle_stage_name:
              LIFECYCLE_STAGES[t.lifecycle_stage as number] ?? "Unknown",
            status: t.status,
            metadata: t.metadata,
          },
        },
      };
    },
  );

  // --- generate_email_content ---
  server.tool(
    "generate_email_content",
    "Generate personalized AI email content for a specific lead.",
    {
      target_id: z
        .string()
        .uuid()
        .describe("The target/lead ID to generate content for"),
      content_type: z
        .enum(["educational", "case_study", "promotional"])
        .default("educational")
        .describe("Type of email content to generate"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const targets = await sql`
        SELECT * FROM targets WHERE id = ${args.target_id} AND organization_id = ${tenantId}
      `;
      if (targets.length === 0) return errorResult("Target not found.");

      const target = targets[0];
      const agentId = await getAgentId(tenantId);
      if (!agentId) return errorResult("AgentPlane not configured.");

      const result = await agentplane.generateContent(
        agentId,
        target as Record<string, unknown>,
        args.content_type,
      );

      const content = await sql`
        INSERT INTO content (organization_id, name, content_type, channel, subject, body, lifecycle_stage, status)
        VALUES (
          ${tenantId},
          ${"AI Generated - " + target.email + " - " + args.content_type},
          ${args.content_type},
          'email',
          ${(result.subject as string) ?? null},
          ${(result.body as string) ?? (result.raw as string) ?? ""},
          ${target.lifecycle_stage},
          'draft'
        )
        RETURNING id
      `;

      return {
        content: [
          {
            type: "text",
            text: `Generated ${args.content_type} email for ${target.email}:\n\n**Subject:** ${result.subject ?? "N/A"}\n\n${result.body ?? ""}`,
          },
        ],
        structuredContent: {
          content: {
            id: String(content[0].id),
            subject: result.subject,
            body: result.body,
            content_type: args.content_type,
          },
          target: { id: String(target.id), email: target.email },
        },
      };
    },
  );

  // --- list_campaigns ---
  server.tool(
    "list_campaigns",
    "List all email campaigns with their status and stats.",
    {
      status: z
        .enum(["draft", "scheduled", "active", "paused", "completed"])
        .optional(),
      limit: z.number().int().max(100).default(20),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);
      const conditions = ["organization_id = $1"];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (args.status) {
        conditions.push(`status = $${idx}`);
        params.push(args.status);
        idx++;
      }

      const rows = await sql.query(
        `SELECT id, name, status, created_at FROM campaigns
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT $${idx}`,
        [...params, args.limit],
      );

      const formatted = rows.map((c: Record<string, unknown>) => ({
        id: String(c.id),
        name: c.name,
        status: c.status,
        created_at: c.created_at
          ? (c.created_at as Date).toISOString()
          : null,
      }));

      const byStatus: Record<string, number> = {};
      for (const c of formatted)
        byStatus[c.status as string] =
          (byStatus[c.status as string] ?? 0) + 1;

      return {
        content: [
          {
            type: "text",
            text: `Found ${formatted.length} campaigns. ${Object.entries(byStatus)
              .map(([s, c]) => `${c} ${s}`)
              .join(", ")}`,
          },
        ],
        structuredContent: {
          campaigns: formatted,
          summary: { total: formatted.length, by_status: byStatus },
        },
      };
    },
  );

  // --- start_campaign ---
  server.tool(
    "start_campaign",
    "Start an email campaign. Only works for campaigns in draft, scheduled, or paused status.",
    {
      campaign_id: z.string().uuid().describe("Campaign ID to start"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const campaigns = await sql`
        SELECT id, name, status FROM campaigns WHERE id = ${args.campaign_id} AND organization_id = ${tenantId}
      `;
      if (campaigns.length === 0) return errorResult("Campaign not found.");

      const campaign = campaigns[0];
      if (!["draft", "scheduled", "paused"].includes(campaign.status as string)) {
        return errorResult(
          `Cannot start campaign in '${campaign.status}' status. Only draft, scheduled, or paused campaigns can be started.`,
        );
      }

      const updated = await sql`
        UPDATE campaigns SET status = 'active', started_at = NOW() WHERE id = ${args.campaign_id}
        RETURNING id, name, status
      `;

      return {
        content: [
          {
            type: "text",
            text: `Campaign '${campaign.name}' is now active and sending emails.`,
          },
        ],
        structuredContent: {
          campaign: {
            id: String(updated[0].id),
            name: updated[0].name,
            status: updated[0].status,
          },
        },
      };
    },
  );

  // --- get_analytics ---
  server.tool(
    "get_analytics",
    "Get email engagement analytics including open rates, click rates, and delivery stats.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe("Number of days to analyze"),
      campaign_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter by specific campaign"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);
      const conditions = [
        "organization_id = $1",
        "created_at >= NOW() - make_interval(days => $2)",
      ];
      const params: unknown[] = [tenantId, args.days];

      if (args.campaign_id) {
        conditions.push("campaign_id = $3");
        params.push(args.campaign_id);
      }

      const rows = await sql.query(
        `SELECT
           COUNT(*) as total_sent,
           COUNT(*) FILTER (WHERE status IN ('delivered','opened','clicked')) as delivered,
           COUNT(*) FILTER (WHERE status IN ('opened','clicked')) as opened,
           COUNT(*) FILTER (WHERE status = 'clicked') as clicked,
           COUNT(*) FILTER (WHERE status = 'bounced') as bounced
         FROM email_sends
         WHERE ${conditions.join(" AND ")}`,
        params,
      );

      const row = rows[0];
      const total = Number(row.total_sent) || 1;
      const delivered = Number(row.delivered) || 0;
      const opened = Number(row.opened) || 0;
      const clicked = Number(row.clicked) || 0;
      const bounced = Number(row.bounced) || 0;

      const metrics = {
        total_sent: total,
        delivered,
        opened,
        clicked,
        bounced,
        delivery_rate:
          total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
        open_rate:
          delivered > 0
            ? Math.round((opened / delivered) * 1000) / 10
            : 0,
        click_rate:
          opened > 0 ? Math.round((clicked / opened) * 1000) / 10 : 0,
        bounce_rate:
          total > 0 ? Math.round((bounced / total) * 1000) / 10 : 0,
      };

      return {
        content: [
          {
            type: "text",
            text: `Last ${args.days} days: ${total} emails sent, ${metrics.delivery_rate}% delivered, ${metrics.open_rate}% opened, ${metrics.click_rate}% clicked`,
          },
        ],
        structuredContent: { metrics, period_days: args.days },
      };
    },
  );

  // --- get_dashboard ---
  server.tool(
    "get_dashboard",
    "Get dashboard with analytics charts showing email sends, deliveries, opens, and clicks over time.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(30)
        .describe("Number of days to show"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const rows = await sql.query(
        `SELECT
           DATE(created_at) as date,
           COUNT(*) as sends,
           COUNT(*) FILTER (WHERE status IN ('delivered','opened','clicked')) as delivered,
           COUNT(*) FILTER (WHERE status IN ('opened','clicked')) as opens,
           COUNT(*) FILTER (WHERE status = 'clicked') as clicks
         FROM email_sends
         WHERE organization_id = $1
           AND created_at >= NOW() - make_interval(days => $2)
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [tenantId, args.days],
      );

      const dailyStats: Record<string, unknown>[] = [];
      const totals = { sends: 0, delivered: 0, opens: 0, clicks: 0 };

      for (const row of rows) {
        dailyStats.push({
          date: row.date,
          sends: Number(row.sends),
          delivered: Number(row.delivered),
          opens: Number(row.opens),
          clicks: Number(row.clicks),
        });
        totals.sends += Number(row.sends);
        totals.delivered += Number(row.delivered);
        totals.opens += Number(row.opens);
        totals.clicks += Number(row.clicks);
      }

      return {
        content: [
          {
            type: "text",
            text: `Last ${args.days} days: ${totals.sends} sends, ${totals.delivered} delivered, ${totals.opens} opens, ${totals.clicks} clicks`,
          },
        ],
        structuredContent: {
          daily_stats: dailyStats,
          totals,
          period_days: args.days,
        },
      };
    },
  );

  // --- get_outbox ---
  server.tool(
    "get_outbox",
    "Get pending outbox items awaiting approval with full email details.",
    {
      status: z
        .enum(["pending", "approved", "rejected", "all"])
        .default("pending"),
      limit: z.number().int().max(100).default(20),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      let statusCondition = "";
      const params: unknown[] = [tenantId, args.limit];
      if (args.status !== "all") {
        statusCondition = "AND o.status = $3";
        params.push(args.status);
      }

      const rows = await sql.query(
        `SELECT
           o.id, o.subject, o.body, o.status, o.created_at, o.scheduled_for,
           t.id as target_id, t.email as target_email,
           t.first_name as target_first_name, t.last_name as target_last_name,
           t.company as target_company
         FROM outbox o
         JOIN targets t ON t.id = o.target_id
         WHERE o.organization_id = $1 ${statusCondition}
         ORDER BY o.created_at DESC
         LIMIT $2`,
        params,
      );

      const items = rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        subject: row.subject,
        body: row.body,
        status: row.status,
        created_at: row.created_at
          ? (row.created_at as Date).toISOString()
          : null,
        scheduled_for: row.scheduled_for
          ? (row.scheduled_for as Date).toISOString()
          : null,
        target: {
          id: String(row.target_id),
          email: row.target_email,
          first_name: row.target_first_name,
          last_name: row.target_last_name,
          company: row.target_company,
        },
      }));

      const counts = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
          COUNT(*) as total
        FROM outbox
        WHERE organization_id = ${tenantId}
      `;

      const c = counts[0];

      return {
        content: [
          {
            type: "text",
            text: `Found ${items.length} outbox items (${c.pending} pending, ${c.approved} approved, ${c.rejected} rejected)`,
          },
        ],
        structuredContent: {
          items,
          counts: {
            pending: Number(c.pending),
            approved: Number(c.approved),
            rejected: Number(c.rejected),
            total: Number(c.total),
          },
        },
      };
    },
  );

  // --- approve_outbox_item ---
  server.tool(
    "approve_outbox_item",
    "Approve an outbox item for sending.",
    {
      outbox_id: z.string().uuid().describe("Outbox item ID to approve"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      return withTransaction(async (client) => {
        const { rows } = await client.query(
          "SELECT id, status, subject FROM outbox WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [args.outbox_id, tenantId],
        );

        if (rows.length === 0) return errorResult("Outbox item not found.");

        const item = rows[0];
        if (item.status !== "pending") {
          return errorResult(
            `Cannot approve item with status '${item.status}'. Only pending items can be approved.`,
          );
        }

        await client.query(
          "UPDATE outbox SET status = 'approved', updated_at = NOW() WHERE id = $1",
          [args.outbox_id],
        );

        await client.query(
          `INSERT INTO email_sends (organization_id, target_id, email, subject, body, status, outbox_id)
           SELECT o.organization_id, o.target_id, t.email, o.subject, o.body, 'queued', o.id
           FROM outbox o JOIN targets t ON t.id = o.target_id
           WHERE o.id = $1`,
          [args.outbox_id],
        );

        return {
          content: [
            { type: "text" as const, text: `Approved email: ${item.subject}` },
          ],
          structuredContent: {
            outbox_id: args.outbox_id,
            status: "approved",
          },
        };
      });
    },
  );

  // --- reject_outbox_item ---
  server.tool(
    "reject_outbox_item",
    "Reject an outbox item.",
    {
      outbox_id: z.string().uuid().describe("Outbox item ID to reject"),
      reason: z.string().optional().describe("Rejection reason"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      return withTransaction(async (client) => {
        const { rows } = await client.query(
          "SELECT id, status, subject FROM outbox WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [args.outbox_id, tenantId],
        );

        if (rows.length === 0) return errorResult("Outbox item not found.");

        const item = rows[0];
        if (item.status !== "pending") {
          return errorResult(
            `Cannot reject item with status '${item.status}'. Only pending items can be rejected.`,
          );
        }

        await client.query(
          "UPDATE outbox SET status = 'rejected', updated_at = NOW() WHERE id = $1",
          [args.outbox_id],
        );

        const reason = args.reason ?? "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Rejected email: ${item.subject}${reason ? ` - Reason: ${reason}` : ""}`,
            },
          ],
          structuredContent: {
            outbox_id: args.outbox_id,
            status: "rejected",
            reason,
          },
        };
      });
    },
  );

  // --- get_sequences ---
  server.tool(
    "get_sequences",
    "Get all sequences with enrollment counts and status.",
    {
      status: z
        .enum(["active", "paused", "draft", "all"])
        .default("all"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      let statusCondition = "";
      const params: unknown[] = [tenantId];
      if (args.status !== "all") {
        statusCondition = "AND s.status = $2";
        params.push(args.status);
      }

      const rows = await sql.query(
        `SELECT
           s.id, s.name, s.status, s.created_at,
           COALESCE(steps.cnt, 0) as step_count,
           COUNT(e.id) FILTER (WHERE e.status = 'active') as active_enrollments,
           COUNT(e.id) FILTER (WHERE e.status = 'completed') as completed_enrollments,
           COUNT(e.id) FILTER (WHERE e.status IN ('exited','converted')) as exited_enrollments
         FROM sequences s
         LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM sequence_steps WHERE sequence_id = s.id) steps ON true
         LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
         WHERE s.organization_id = $1 ${statusCondition}
         GROUP BY s.id, steps.cnt
         ORDER BY s.created_at DESC`,
        params,
      );

      const sequences = rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        name: row.name,
        status: row.status,
        step_count: Number(row.step_count),
        enrollments: {
          active: Number(row.active_enrollments),
          completed: Number(row.completed_enrollments),
          exited: Number(row.exited_enrollments),
        },
        created_at: row.created_at
          ? (row.created_at as Date).toISOString()
          : null,
      }));

      const byStatus: Record<string, number> = {};
      for (const s of sequences)
        byStatus[s.status as string] =
          (byStatus[s.status as string] ?? 0) + 1;

      return {
        content: [
          {
            type: "text",
            text: `Found ${sequences.length} sequences. ${Object.entries(byStatus)
              .map(([s, c]) => `${c} ${s}`)
              .join(", ")}`,
          },
        ],
        structuredContent: {
          sequences,
          summary: { total: sequences.length, by_status: byStatus },
        },
      };
    },
  );

  // --- get_step_content ---
  server.tool(
    "get_step_content",
    "Get the content blocks for a sequence step, including personalization settings.",
    {
      step_id: z.string().uuid().describe("The sequence step ID"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const rows = await sql`
        SELECT ss.* FROM sequence_steps ss
        JOIN sequences s ON s.id = ss.sequence_id
        WHERE ss.id = ${args.step_id} AND s.organization_id = ${tenantId}
      `;

      if (rows.length === 0) return errorResult("Step not found.");

      const step = rows[0];
      const builderContent =
        (step.builder_content as Record<string, Record<string, unknown>>) ?? {};

      const blocks = Object.entries(builderContent).map(
        ([blockId, block]) => {
          const personalization =
            (
              block.data as Record<string, unknown> | undefined
            )?.personalization as Record<string, unknown> | undefined;
          return {
            block_id: blockId,
            type: block.type,
            has_personalization: personalization?.enabled === true,
            prompt:
              personalization?.enabled === true
                ? personalization?.prompt ?? ""
                : null,
          };
        },
      );

      const personalizedCount = blocks.filter(
        (b) => b.has_personalization,
      ).length;

      return {
        content: [
          {
            type: "text",
            text: `Step has ${blocks.length} blocks, ${personalizedCount} with personalization enabled.`,
          },
        ],
        structuredContent: {
          step_id: String(step.id),
          subject: step.subject,
          blocks,
          builder_content: builderContent,
        },
      };
    },
  );

  // --- set_block_personalization ---
  server.tool(
    "set_block_personalization",
    "Enable or disable AI personalization on a specific content block within a step.",
    {
      step_id: z.string().uuid().describe("The sequence step ID"),
      block_id: z
        .string()
        .describe("Block ID within builder_content"),
      enabled: z
        .boolean()
        .describe("Whether personalization is enabled"),
      prompt: z
        .string()
        .max(1000)
        .optional()
        .describe("Personalization instructions for AI"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const rows = await sql`
        SELECT ss.* FROM sequence_steps ss
        JOIN sequences s ON s.id = ss.sequence_id
        WHERE ss.id = ${args.step_id} AND s.organization_id = ${tenantId}
      `;

      if (rows.length === 0) return errorResult("Step not found.");

      const step = rows[0];
      const builderContent =
        (step.builder_content as Record<
          string,
          Record<string, unknown>
        >) ?? {};

      if (!(args.block_id in builderContent)) {
        return errorResult(
          `Block ${args.block_id} not found in step.`,
        );
      }

      const block = builderContent[args.block_id];
      if (!block.data) block.data = {};
      (block.data as Record<string, unknown>).personalization = {
        enabled: args.enabled,
        prompt: args.enabled ? (args.prompt ?? "") : "",
      };

      await sql`
        UPDATE sequence_steps
        SET builder_content = ${JSON.stringify(builderContent)}, has_unpublished_changes = true
        WHERE id = ${args.step_id}
      `;

      const action = args.enabled ? "enabled" : "disabled";
      return {
        content: [
          {
            type: "text",
            text: `Personalization ${action} for block ${args.block_id}.`,
          },
        ],
        structuredContent: {
          step_id: args.step_id,
          block_id: args.block_id,
          enabled: args.enabled,
        },
      };
    },
  );

  // --- preview_block_personalization ---
  server.tool(
    "preview_block_personalization",
    "Preview what AI would generate for a personalized block without scheduling.",
    {
      step_id: z.string().uuid().describe("The sequence step ID"),
      block_id: z
        .string()
        .describe("Block ID within builder_content"),
      target_id: z
        .string()
        .uuid()
        .describe("Target/lead ID to personalize for"),
    },
    async (args, extra) => {
      const { tenantId } = getAuth(extra);

      const [stepRows, targetRows] = await Promise.all([
        sql`
          SELECT ss.* FROM sequence_steps ss
          JOIN sequences s ON s.id = ss.sequence_id
          WHERE ss.id = ${args.step_id} AND s.organization_id = ${tenantId}
        `,
        sql`
          SELECT * FROM targets WHERE id = ${args.target_id} AND organization_id = ${tenantId}
        `,
      ]);

      if (stepRows.length === 0) return errorResult("Step not found.");
      if (targetRows.length === 0) return errorResult("Target not found.");

      const step = stepRows[0];
      const target = targetRows[0];
      const builderContent =
        (step.builder_content as Record<
          string,
          Record<string, unknown>
        >) ?? {};

      if (!(args.block_id in builderContent)) {
        return errorResult(
          `Block ${args.block_id} not found in step.`,
        );
      }

      const block = builderContent[args.block_id];
      const personalization = (
        block.data as Record<string, unknown> | undefined
      )?.personalization as Record<string, unknown> | undefined;

      if (!personalization?.enabled) {
        return errorResult("Personalization is not enabled for this block.");
      }

      const agentId = await getAgentId(tenantId);
      if (!agentId) return errorResult("AgentPlane not configured.");

      const result = await agentplane.invokeSkill(
        agentId,
        "envoy-content-generation",
        {
          target: target as Record<string, unknown>,
          block_content: block,
          prompt: personalization.prompt,
          mode: "preview",
        },
      );

      return {
        content: [
          {
            type: "text",
            text: `Preview for ${target.email}:\n\n${result.body ?? result.raw ?? JSON.stringify(result)}`,
          },
        ],
        structuredContent: {
          preview: result,
          target: { id: String(target.id), email: target.email },
          block_id: args.block_id,
        },
      };
    },
  );
}

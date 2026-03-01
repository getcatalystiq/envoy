import { sql } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function getOverview(
  orgId: string,
  opts: {
    startDate?: string;
    endDate?: string;
    campaignId?: string;
  } = {}
): Promise<Row> {
  const now = new Date().toISOString();
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const startDate = opts.startDate ?? thirtyDaysAgo;
  const endDate = opts.endDate ?? now;
  const campaignId = opts.campaignId ?? null;

  const rows = await sql`
    SELECT
      COUNT(*)::int as total_sent,
      COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::int as delivered,
      COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::int as opened,
      COUNT(*) FILTER (WHERE status = 'clicked')::int as clicked,
      COUNT(*) FILTER (WHERE status = 'bounced')::int as bounced
    FROM email_sends
    WHERE organization_id = ${orgId}
      AND created_at >= ${startDate}::timestamptz
      AND created_at <= ${endDate}::timestamptz
      AND (${campaignId}::uuid IS NULL OR campaign_id = ${campaignId}::uuid)
  `;

  const row = rows[0];
  const total = row.total_sent || 1;
  const delivered = row.delivered || 0;
  const opened = row.opened || 0;
  const clicked = row.clicked || 0;
  const bounced = row.bounced || 0;

  return {
    total_sent: total,
    delivered,
    opened,
    clicked,
    bounced,
    delivery_rate: total > 0 ? Math.round((delivered / total) * 10000) / 100 : 0,
    open_rate: delivered > 0 ? Math.round((opened / delivered) * 10000) / 100 : 0,
    click_rate: opened > 0 ? Math.round((clicked / opened) * 10000) / 100 : 0,
    bounce_rate: total > 0 ? Math.round((bounced / total) * 10000) / 100 : 0,
  };
}

export async function getLifecycleDistribution(
  orgId: string,
  targetTypeId?: string
): Promise<Row> {
  const rows = await sql`
    SELECT lifecycle_stage, COUNT(*)::int as count
    FROM targets
    WHERE organization_id = ${orgId}
      AND status = 'active'
      AND (${targetTypeId ?? null}::uuid IS NULL OR target_type_id = ${targetTypeId ?? null}::uuid)
    GROUP BY lifecycle_stage
    ORDER BY lifecycle_stage
  `;

  const stages: Record<number, string> = {
    0: "Unaware",
    1: "Aware",
    2: "Interested",
    3: "Considering",
    4: "Intent",
    5: "Converted",
    6: "Advocate",
  };

  const distribution: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    distribution[stages[i]] = 0;
  }
  for (const row of rows) {
    const stageName = stages[row.lifecycle_stage] ?? "Unknown";
    distribution[stageName] = row.count;
  }

  return {
    distribution,
    total: Object.values(distribution).reduce((a, b) => a + b, 0),
  };
}

export async function getEngagementMetrics(
  orgId: string,
  opts: { days?: number; campaignId?: string } = {}
): Promise<Row[]> {
  const { days = 30, campaignId = null } = opts;

  const startDate = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await sql`
    SELECT
      DATE(created_at) as date,
      COUNT(*)::int as sent,
      COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::int as opened,
      COUNT(*) FILTER (WHERE status = 'clicked')::int as clicked
    FROM email_sends
    WHERE organization_id = ${orgId}
      AND created_at >= ${startDate}::timestamptz
      AND (${campaignId}::uuid IS NULL OR campaign_id = ${campaignId}::uuid)
    GROUP BY DATE(created_at)
    ORDER BY date
  `;

  return rows.map((row) => ({
    date: String(row.date),
    sent: row.sent,
    opened: row.opened,
    clicked: row.clicked,
  }));
}

export async function getTimeSeries(
  orgId: string,
  opts: { startDate?: string; endDate?: string } = {}
): Promise<{ data: Row[]; meta: Row }> {
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const startDate = opts.startDate ?? sevenDaysAgo;
  const endDate = opts.endDate ?? now;

  // Determine granularity based on date range
  const hoursDiff =
    (new Date(endDate).getTime() - new Date(startDate).getTime()) /
    (1000 * 3600);
  const granularity = hoursDiff <= 48 ? "hour" : "day";

  // Use raw query since we need dynamic granularity
  const query = `
    SELECT
      date_trunc('${granularity}', sent_at) as timestamp,
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int as sent,
      COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int as delivered,
      COUNT(*) FILTER (WHERE bounce_type = 'Transient')::int as transient_bounces,
      COUNT(*) FILTER (WHERE bounce_type = 'Permanent')::int as permanent_bounces,
      COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int as complaints,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int as opens,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int as clicks
    FROM email_sends
    WHERE organization_id = $1
      AND sent_at >= $2::timestamptz
      AND sent_at < $3::timestamptz
    GROUP BY date_trunc('${granularity}', sent_at)
    ORDER BY timestamp
  `;
  const rows = await sql.query(query, [orgId, startDate, endDate]);

  return {
    data: rows.map((row) => ({
      timestamp: row.timestamp,
      sent: row.sent || 0,
      delivered: row.delivered || 0,
      transient_bounces: row.transient_bounces || 0,
      permanent_bounces: row.permanent_bounces || 0,
      complaints: row.complaints || 0,
      opens: row.opens || 0,
      clicks: row.clicks || 0,
    })),
    meta: {
      granularity: granularity === "hour" ? "hourly" : "daily",
      start_date: startDate,
      end_date: endDate,
    },
  };
}

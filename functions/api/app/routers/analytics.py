"""Analytics router."""

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Query

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    AnalyticsResponse,
    MetricsDataPoint,
    MetricsMetadata,
    MetricsTimeSeriesResponse,
)

router = APIRouter()


@router.get("/overview", response_model=AnalyticsResponse)
async def get_analytics_overview(
    org_id: CurrentOrg,
    db: DBConnection,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    campaign_id: Optional[UUID] = None,
) -> AnalyticsResponse:
    """Get analytics overview."""
    # Default to last 30 days
    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    # Build query conditions
    conditions = ["organization_id = $1", "created_at >= $2", "created_at <= $3"]
    params = [org_id, start_date, end_date]

    if campaign_id:
        conditions.append(f"campaign_id = ${len(params) + 1}")
        params.append(campaign_id)

    where_clause = " AND ".join(conditions)

    # Get counts
    row = await db.fetchrow(
        f"""
        SELECT
            COUNT(*) as total_sent,
            COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')) as delivered,
            COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opened,
            COUNT(*) FILTER (WHERE status = 'clicked') as clicked,
            COUNT(*) FILTER (WHERE status = 'bounced') as bounced
        FROM email_sends
        WHERE {where_clause}
        """,
        *params,
    )

    total = row["total_sent"] or 1  # Avoid division by zero
    delivered = row["delivered"] or 0
    opened = row["opened"] or 0
    clicked = row["clicked"] or 0
    bounced = row["bounced"] or 0

    return AnalyticsResponse(
        total_sent=total,
        delivered=delivered,
        opened=opened,
        clicked=clicked,
        bounced=bounced,
        delivery_rate=round(delivered / total * 100, 2) if total > 0 else 0,
        open_rate=round(opened / delivered * 100, 2) if delivered > 0 else 0,
        click_rate=round(clicked / opened * 100, 2) if opened > 0 else 0,
        bounce_rate=round(bounced / total * 100, 2) if total > 0 else 0,
    )


@router.get("/lifecycle")
async def get_lifecycle_distribution(
    org_id: CurrentOrg,
    db: DBConnection,
    target_type_id: Optional[UUID] = None,
) -> dict:
    """Get distribution of targets across lifecycle stages."""
    if target_type_id:
        rows = await db.fetch(
            """
            SELECT lifecycle_stage, COUNT(*) as count
            FROM targets
            WHERE organization_id = $1 AND target_type_id = $2 AND status = 'active'
            GROUP BY lifecycle_stage
            ORDER BY lifecycle_stage
            """,
            org_id,
            target_type_id,
        )
    else:
        rows = await db.fetch(
            """
            SELECT lifecycle_stage, COUNT(*) as count
            FROM targets
            WHERE organization_id = $1 AND status = 'active'
            GROUP BY lifecycle_stage
            ORDER BY lifecycle_stage
            """,
            org_id,
        )

    stages = {
        0: "Unaware",
        1: "Aware",
        2: "Interested",
        3: "Considering",
        4: "Intent",
        5: "Converted",
        6: "Advocate",
    }

    distribution = {stages[i]: 0 for i in range(7)}
    for row in rows:
        stage_name = stages.get(row["lifecycle_stage"], "Unknown")
        distribution[stage_name] = row["count"]

    return {"distribution": distribution, "total": sum(distribution.values())}


@router.get("/engagement")
async def get_engagement_metrics(
    org_id: CurrentOrg,
    db: DBConnection,
    days: int = Query(30, ge=1, le=365),
    campaign_id: Optional[UUID] = None,
) -> dict:
    """Get engagement metrics over time."""
    start_date = datetime.utcnow() - timedelta(days=days)

    if campaign_id:
        rows = await db.fetch(
            """
            SELECT
                DATE(created_at) as date,
                COUNT(*) as sent,
                COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opened,
                COUNT(*) FILTER (WHERE status = 'clicked') as clicked
            FROM email_sends
            WHERE organization_id = $1 AND campaign_id = $2 AND created_at >= $3
            GROUP BY DATE(created_at)
            ORDER BY date
            """,
            org_id,
            campaign_id,
            start_date,
        )
    else:
        rows = await db.fetch(
            """
            SELECT
                DATE(created_at) as date,
                COUNT(*) as sent,
                COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opened,
                COUNT(*) FILTER (WHERE status = 'clicked') as clicked
            FROM email_sends
            WHERE organization_id = $1 AND created_at >= $2
            GROUP BY DATE(created_at)
            ORDER BY date
            """,
            org_id,
            start_date,
        )

    return {
        "metrics": [
            {
                "date": str(row["date"]),
                "sent": row["sent"],
                "opened": row["opened"],
                "clicked": row["clicked"],
            }
            for row in rows
        ]
    }


@router.get("/metrics", response_model=MetricsTimeSeriesResponse)
async def get_metrics_time_series(
    org_id: CurrentOrg,
    db: DBConnection,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
) -> MetricsTimeSeriesResponse:
    """Get time-series email metrics for charts."""
    # Default to last 7 days
    if not end_date:
        end_date = datetime.now(timezone.utc)
    if not start_date:
        start_date = end_date - timedelta(days=7)

    # Determine granularity based on date range
    hours_diff = (end_date - start_date).total_seconds() / 3600
    granularity = "hour" if hours_diff <= 48 else "day"

    rows = await db.fetch(
        f"""
        SELECT
            date_trunc('{granularity}', sent_at) as timestamp,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL) as sent,
            COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) as delivered,
            COUNT(*) FILTER (WHERE bounce_type = 'Transient') as transient_bounces,
            COUNT(*) FILTER (WHERE bounce_type = 'Permanent') as permanent_bounces,
            COUNT(*) FILTER (WHERE complained_at IS NOT NULL) as complaints,
            COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opens,
            COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicks
        FROM email_sends
        WHERE organization_id = $1
          AND sent_at >= $2
          AND sent_at < $3
        GROUP BY date_trunc('{granularity}', sent_at)
        ORDER BY timestamp
        """,
        org_id,
        start_date,
        end_date,
    )

    data = [
        MetricsDataPoint(
            timestamp=row["timestamp"],
            sent=row["sent"] or 0,
            delivered=row["delivered"] or 0,
            transient_bounces=row["transient_bounces"] or 0,
            permanent_bounces=row["permanent_bounces"] or 0,
            complaints=row["complaints"] or 0,
            opens=row["opens"] or 0,
            clicks=row["clicks"] or 0,
        )
        for row in rows
    ]

    return MetricsTimeSeriesResponse(
        data=data,
        meta=MetricsMetadata(
            granularity="hourly" if granularity == "hour" else "daily",
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
        ),
    )

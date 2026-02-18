#!/usr/bin/env python3
"""Backfill agentplane_tenant_id and agentplane_agent_id for existing organizations.

Usage:
    # Dry run (default)
    python scripts/backfill_agentplane.py

    # Actually apply changes
    python scripts/backfill_agentplane.py --apply

    # Override defaults
    python scripts/backfill_agentplane.py --apply \
        --tenant-id YOUR_TENANT_ID \
        --agent-id YOUR_AGENT_ID

Requires:
    - DB tunnel running (./scripts/db-tunnel.sh dev 5433)
    - AURORA_HOST, AURORA_PORT, AURORA_SECRET_ARN env vars (or defaults)
"""

import argparse
import asyncio
import json
import os
import sys

import asyncpg
import boto3

# Defaults from user-provided values
DEFAULT_TENANT_ID = "7db4538b-76f5-4ffc-b287-f135767009db"
DEFAULT_AGENT_ID = "69199475-d9bc-4c72-b7f8-776d3ffe86d6"


async def get_db_credentials() -> dict:
    """Get database credentials from Secrets Manager or env vars."""
    secret_arn = os.environ.get("AURORA_SECRET_ARN", "envoy-dev-aurora-credentials")

    if os.environ.get("AURORA_PASSWORD"):
        return {
            "host": os.environ.get("AURORA_HOST", "localhost"),
            "port": int(os.environ.get("AURORA_PORT", "5433")),
            "user": os.environ.get("AURORA_USER", "envoy"),
            "password": os.environ["AURORA_PASSWORD"],
            "database": os.environ.get("AURORA_DATABASE", "envoy"),
        }

    try:
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_arn)
        secret = json.loads(response["SecretString"])
        return {
            "host": os.environ.get("AURORA_HOST", secret.get("host", "localhost")),
            "port": int(os.environ.get("AURORA_PORT", secret.get("port", "5433"))),
            "user": secret.get("username", "envoy"),
            "password": secret["password"],
            "database": os.environ.get("AURORA_DATABASE", secret.get("dbname", "envoy")),
        }
    except Exception as e:
        print(f"Warning: Could not fetch secrets ({e}), using local defaults")
        return {
            "host": os.environ.get("AURORA_HOST", "localhost"),
            "port": int(os.environ.get("AURORA_PORT", "5433")),
            "user": os.environ.get("AURORA_USER", "envoy"),
            "password": os.environ.get("AURORA_PASSWORD", "envoy"),
            "database": os.environ.get("AURORA_DATABASE", "envoy"),
        }


async def main(tenant_id: str, agent_id: str, apply: bool) -> None:
    """Backfill agentplane columns for organizations missing them."""
    creds = await get_db_credentials()
    conn = await asyncpg.connect(**creds)

    try:
        # Find orgs that need backfilling
        rows = await conn.fetch(
            """
            SELECT id, name, agentplane_tenant_id, agentplane_agent_id
            FROM organizations
            WHERE agentplane_agent_id IS NULL
            ORDER BY created_at
            """
        )

        if not rows:
            print("No organizations need backfilling.")
            return

        print(f"Found {len(rows)} organization(s) to backfill:\n")
        for row in rows:
            print(f"  {row['id']}  {row['name']}")

        print(f"\nWill set:")
        print(f"  agentplane_tenant_id = {tenant_id}")
        print(f"  agentplane_agent_id  = {agent_id}")

        if not apply:
            print("\nDry run - no changes made. Pass --apply to execute.")
            return

        updated = await conn.execute(
            """
            UPDATE organizations
            SET agentplane_tenant_id = $1,
                agentplane_agent_id = $2
            WHERE agentplane_agent_id IS NULL
            """,
            tenant_id,
            agent_id,
        )

        print(f"\nDone. {updated}")

    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill AgentPlane columns")
    parser.add_argument("--apply", action="store_true", help="Actually apply changes")
    parser.add_argument("--tenant-id", default=DEFAULT_TENANT_ID, help="AgentPlane tenant ID")
    parser.add_argument("--agent-id", default=DEFAULT_AGENT_ID, help="AgentPlane agent ID")
    args = parser.parse_args()

    asyncio.run(main(args.tenant_id, args.agent_id, args.apply))

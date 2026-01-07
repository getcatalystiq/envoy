"""Database utilities with RLS context support."""

import json
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

import asyncpg
import boto3

_pool: Optional[asyncpg.Pool] = None
_credentials: Optional[dict] = None


def _get_credentials() -> dict:
    """Get database credentials from Secrets Manager."""
    global _credentials

    if _credentials is None:
        secret_arn = os.environ.get("AURORA_SECRET_ARN")
        if secret_arn:
            client = boto3.client("secretsmanager")
            response = client.get_secret_value(SecretId=secret_arn)
            _credentials = json.loads(response["SecretString"])
        else:
            # Fallback for local development
            _credentials = {
                "host": os.environ.get("DB_HOST", "localhost"),
                "port": int(os.environ.get("DB_PORT", "5432")),
                "username": os.environ.get("DB_USER", "envoy_admin"),
                "password": os.environ.get("DB_PASSWORD", ""),
            }

    return _credentials


async def get_pool() -> asyncpg.Pool:
    """Get or create connection pool with Lambda-optimized settings."""
    global _pool

    if _pool is None:
        creds = _get_credentials()
        _pool = await asyncpg.create_pool(
            host=os.environ.get("AURORA_HOST", creds.get("host", "localhost")),
            port=int(creds.get("port", 5432)),
            database=os.environ.get("AURORA_DATABASE", "envoy"),
            user=creds["username"],
            password=creds["password"],
            min_size=1,
            max_size=1,
            command_timeout=30,
            statement_cache_size=100,
            max_inactive_connection_lifetime=60,
        )

    return _pool


@asynccontextmanager
async def get_connection(
    org_id: Optional[str] = None,
) -> AsyncGenerator[asyncpg.Connection, None]:
    """Get connection with RLS context set."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        if org_id:
            await conn.execute(f"SET app.current_org_id = '{org_id}'")
        try:
            yield conn
        finally:
            if org_id:
                await conn.execute("RESET app.current_org_id")


@asynccontextmanager
async def get_raw_connection() -> AsyncGenerator[asyncpg.Connection, None]:
    """Get connection without RLS context (for auth/system operations)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


@asynccontextmanager
async def get_transaction(
    org_id: str,
) -> AsyncGenerator[asyncpg.Connection, None]:
    """Get connection with transaction and RLS context."""
    async with get_connection(org_id) as conn:
        async with conn.transaction():
            yield conn


async def close_pool() -> None:
    """Close the connection pool."""
    global _pool

    if _pool is not None:
        await _pool.close()
        _pool = None

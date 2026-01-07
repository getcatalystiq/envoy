"""Lambda warmup handler to keep functions and Aurora warm."""

import asyncio
from typing import Any

from shared.database import get_pool


async def warmup() -> dict[str, str]:
    """Keep Lambda and Aurora warm."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("SELECT 1")
    return {"status": "warm"}


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, str]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(warmup())

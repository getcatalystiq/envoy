"""Parallel personalization processing for sequence blocks."""

import asyncio
import copy
import logging
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class MavenClient(Protocol):
    """Protocol for Maven client dependency."""

    async def invoke_skill(
        self, skill_name: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...


@dataclass
class PersonalizationError:
    """Error details for a failed block personalization."""

    block_id: str
    error: str


@dataclass
class PersonalizationResult:
    """Result of a single block personalization attempt."""

    block_id: str
    content: str
    success: bool
    error: str | None = None


# Allowlisted target fields for security
ALLOWED_TARGET_FIELDS = frozenset(["first_name", "last_name", "company", "role", "email"])


def sanitize_target_data(target: dict[str, Any]) -> dict[str, Any]:
    """Strict allowlist for target data passed to Maven, including metadata."""
    result: dict[str, Any] = {
        field: str(target[field])[:100]
        for field in ALLOWED_TARGET_FIELDS
        if field in target and target[field]
    }

    # Include metadata if present (sanitize string values to 500 chars max)
    metadata = target.get("metadata")
    if metadata and isinstance(metadata, dict):
        sanitized_metadata: dict[str, Any] = {}
        for key, value in metadata.items():
            if isinstance(value, str):
                sanitized_metadata[key] = value[:500]
            elif isinstance(value, (int, float, bool)) or value is None:
                sanitized_metadata[key] = value
            elif isinstance(value, list):
                # Allow lists of primitives
                sanitized_metadata[key] = [
                    v[:500] if isinstance(v, str) else v
                    for v in value[:20]  # Limit list length
                    if isinstance(v, (str, int, float, bool)) or v is None
                ]
        if sanitized_metadata:
            result["metadata"] = sanitized_metadata

    return result


def extract_block_content(block: dict[str, Any]) -> str | None:
    """Extract text content from a block based on its type."""
    block_type = block.get("type")
    props = block.get("data", {}).get("props", {})

    content: str | None = None

    if block_type in ("Text", "Heading", "Button"):
        content = props.get("text")
    elif block_type == "Html":
        content = props.get("contents")

    return content if content else None


def apply_personalized_content(block: dict[str, Any], personalized: str) -> dict[str, Any]:
    """Create a new block with personalized content applied (no mutation)."""
    result = copy.deepcopy(block)
    block_type = result.get("type")

    if block_type in ("Text", "Heading", "Button"):
        result["data"]["props"]["text"] = personalized
    elif block_type == "Html":
        result["data"]["props"]["contents"] = personalized

    return result


async def _personalize_block(
    block_id: str,
    block: dict[str, Any],
    target_data: dict[str, Any],
    maven_client: MavenClient,
    semaphore: asyncio.Semaphore,
    timeout_seconds: float = 300.0,
) -> tuple[str, dict[str, Any] | None, PersonalizationError | None]:
    """Personalize a single block with bounded concurrency and timeout."""
    personalization = block.get("data", {}).get("personalization", {})

    if not personalization.get("enabled"):
        return block_id, None, None

    prompt = personalization.get("prompt", "").strip()
    block_type = block.get("type")
    original_content = extract_block_content(block)

    if not original_content:
        return block_id, None, None

    async with semaphore:
        try:
            result = await asyncio.wait_for(
                maven_client.invoke_skill(
                    "envoy-content-generation",
                    {
                        "mode": "block_personalization",
                        "original_content": original_content,
                        "additional_instructions": prompt,
                        "target": sanitize_target_data(target_data),
                        "block_type": block_type,
                    },
                ),
                timeout=timeout_seconds,
            )

            # Extract personalized content from Maven response
            personalized = result.get("body") or result.get("content") or original_content
            updated_block = apply_personalized_content(block, personalized)
            return block_id, updated_block, None

        except asyncio.TimeoutError:
            logger.warning("Personalization timeout for block %s", block_id)
            return block_id, None, PersonalizationError(block_id=block_id, error="Timeout")

        except Exception as e:
            logger.warning("Personalization failed for block %s: %s", block_id, e)
            return block_id, None, PersonalizationError(block_id=block_id, error=str(e))


async def process_personalization(
    builder_content: dict[str, dict[str, Any]],
    target_data: dict[str, Any],
    maven_client: MavenClient,
    max_concurrent: int = 5,
    timeout_seconds: float = 300.0,
) -> tuple[dict[str, dict[str, Any]], list[PersonalizationError]]:
    """
    Process blocks with personalization enabled through Maven.
    Uses parallel processing with bounded concurrency.

    Args:
        builder_content: The document's block dictionary from builder_content
        target_data: Target/recipient data for personalization
        maven_client: Maven client instance
        max_concurrent: Maximum concurrent Maven calls (default: 5)
        timeout_seconds: Timeout per Maven call (default: 300.0)

    Returns:
        Tuple of (modified_content, errors) where errors contains
        any blocks that failed personalization.
    """
    if not builder_content:
        return builder_content, []

    modified_content = copy.deepcopy(builder_content)
    semaphore = asyncio.Semaphore(max_concurrent)

    tasks = [
        _personalize_block(
            block_id, block, target_data, maven_client, semaphore, timeout_seconds
        )
        for block_id, block in modified_content.items()
    ]

    results = await asyncio.gather(*tasks)
    errors: list[PersonalizationError] = []

    for block_id, result, error in results:
        if error:
            errors.append(error)
        elif result is not None:
            modified_content[block_id] = result

    logger.info(
        "Personalization complete: %d blocks processed, %d errors",
        len(results) - len(errors),
        len(errors),
    )

    return modified_content, errors


def has_personalized_blocks(builder_content: dict[str, dict[str, Any]]) -> bool:
    """Check if any blocks have personalization enabled."""
    if not builder_content:
        return False

    for block in builder_content.values():
        personalization = block.get("data", {}).get("personalization", {})
        if personalization.get("enabled"):
            return True

    return False

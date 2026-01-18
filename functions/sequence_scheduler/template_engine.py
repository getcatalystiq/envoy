"""Simple template engine for email variable replacement."""

import copy
import os
import re
from typing import Any

# Base URL for unsubscribe links
API_BASE_URL = os.environ.get("API_BASE_URL", "https://api.envoy.app")
UNSUBSCRIBE_BASE_URL = f"{API_BASE_URL}/unsubscribe"


def replace_templates_in_text(text: str, replacements: dict[str, str]) -> str:
    """Replace {{variable}} placeholders in a string."""

    def replace_match(match: re.Match) -> str:
        var_name = match.group(1)
        return replacements.get(var_name, match.group(0))

    return re.sub(r"\{\{(\w+)\}\}", replace_match, text)


def replace_templates_in_blocks(
    builder_content: dict[str, dict[str, Any]],
    target_data: dict[str, Any],
    target_id: str,
) -> dict[str, dict[str, Any]]:
    """Replace {{variable}} placeholders in all block content.

    Supported variables:
    - {{first_name}}, {{last_name}}, {{company}}, {{title}}, {{email}}
    - {{unsubscribe_link}} - Full unsubscribe URL
    """
    replacements = {
        "first_name": target_data.get("first_name") or "",
        "last_name": target_data.get("last_name") or "",
        "company": target_data.get("company") or "",
        "title": target_data.get("title") or "",
        "email": target_data.get("email") or "",
        "unsubscribe_link": f"{UNSUBSCRIBE_BASE_URL}/{target_id}",
    }

    result = copy.deepcopy(builder_content)

    for block_id, block in result.items():
        block_type = block.get("type")
        props = block.get("data", {}).get("props", {})

        # Replace in text-based blocks
        if block_type in ("Text", "Heading", "Button") and "text" in props:
            props["text"] = replace_templates_in_text(props["text"], replacements)
        elif block_type == "Html" and "contents" in props:
            props["contents"] = replace_templates_in_text(props["contents"], replacements)

    return result

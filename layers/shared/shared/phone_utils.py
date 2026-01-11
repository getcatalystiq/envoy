"""Phone number normalization utilities for target matching."""

import re


def normalize_phone(phone: str | None) -> str | None:
    """
    Normalize phone number to E.164 format for consistent matching.

    E.164 format: +[country code][subscriber number]
    Maximum 15 digits total.

    Examples:
        "(202) 555-1234" -> "+12025551234" (assumes US)
        "202-555-1234" -> "+12025551234" (assumes US)
        "+1 (202) 555-1234" -> "+12025551234"
        "+44 20 7946 0958" -> "+442079460958"
        "1-800-555-1234" -> "+18005551234"
        "555-1234" -> None (too short, ambiguous)
        "" -> None
        None -> None

    Args:
        phone: Raw phone number string in any format

    Returns:
        E.164 formatted phone number or None if invalid/too short
    """
    if not phone:
        return None

    phone = phone.strip()
    if not phone:
        return None

    # Check if it starts with + (has country code)
    has_plus = phone.startswith("+")

    # Extract only digits
    digits = re.sub(r"\D", "", phone)

    # Reject if too few digits (need at least 7 for a valid phone)
    if not digits or len(digits) < 7:
        return None

    # Reject if too many digits (E.164 max is 15)
    if len(digits) > 15:
        return None

    # Handle different formats
    if has_plus:
        # Already has country code indicator
        return f"+{digits}"
    elif digits.startswith("1") and len(digits) == 11:
        # US/Canada with country code (1XXXXXXXXXX)
        return f"+{digits}"
    elif len(digits) == 10:
        # US/Canada without country code - assume US (+1)
        return f"+1{digits}"
    elif digits.startswith("1") and len(digits) == 10:
        # Edge case: 10 digits starting with 1 could be US area code
        # starting with 1 (rare but valid like 123-456-7890)
        return f"+1{digits}"
    else:
        # Unknown format - prefix with + and return as-is
        # This handles international numbers without + prefix
        return f"+{digits}"


def phones_match(phone1: str | None, phone2: str | None) -> bool:
    """
    Check if two phone numbers match after normalization.

    Args:
        phone1: First phone number
        phone2: Second phone number

    Returns:
        True if both normalize to the same value, False otherwise
    """
    norm1 = normalize_phone(phone1)
    norm2 = normalize_phone(phone2)

    if norm1 is None or norm2 is None:
        return False

    return norm1 == norm2


def format_phone_display(phone: str | None) -> str | None:
    """
    Format a phone number for human-readable display.

    Assumes US/Canada format for 11-digit numbers starting with 1.

    Args:
        phone: Phone number (raw or normalized)

    Returns:
        Formatted phone like "(202) 555-1234" or original if can't format
    """
    if not phone:
        return None

    normalized = normalize_phone(phone)
    if not normalized:
        return phone  # Return original if can't normalize

    digits = normalized.lstrip("+")

    # Format US/Canada numbers (11 digits starting with 1)
    if len(digits) == 11 and digits.startswith("1"):
        return f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"

    # Format 10-digit US numbers
    if len(digits) == 10:
        return f"({digits[0:3]}) {digits[3:6]}-{digits[6:]}"

    # Return E.164 format for other numbers
    return normalized

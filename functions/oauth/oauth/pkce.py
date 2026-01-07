"""PKCE (Proof Key for Code Exchange) utilities."""

import base64
import hashlib
import secrets


def generate_code_verifier(length: int = 64) -> str:
    """
    Generate a cryptographically random code verifier.

    Args:
        length: Length of verifier (43-128 chars per RFC 7636)

    Returns:
        URL-safe base64 encoded random string
    """
    random_bytes = secrets.token_bytes(length)
    verifier = base64.urlsafe_b64encode(random_bytes).decode("utf-8").rstrip("=")
    return verifier[:128]


def generate_code_challenge(verifier: str, method: str = "S256") -> str:
    """
    Generate code challenge from verifier.

    Args:
        verifier: The code verifier
        method: Challenge method (S256 or plain)

    Returns:
        Code challenge string
    """
    if method == "plain":
        return verifier
    elif method == "S256":
        digest = hashlib.sha256(verifier.encode("utf-8")).digest()
        challenge = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
        return challenge
    else:
        raise ValueError(f"Unsupported code challenge method: {method}")


def verify_code_challenge(
    verifier: str,
    challenge: str,
    method: str = "S256"
) -> bool:
    """
    Verify that a code verifier matches a code challenge.

    Args:
        verifier: The code verifier from token request
        challenge: The code challenge from authorization request
        method: Challenge method used

    Returns:
        True if verifier matches challenge
    """
    expected_challenge = generate_code_challenge(verifier, method)
    return secrets.compare_digest(expected_challenge, challenge)

"""Configuration management."""

import os
import json
from dataclasses import dataclass, field
from typing import Optional


def _get_jwt_secret() -> Optional[str]:
    """Get JWT secret from Secrets Manager or environment variable."""
    # First try environment variable (for local development)
    if secret := os.environ.get("JWT_SECRET_KEY"):
        return secret

    # Then try to load from Secrets Manager
    secret_arn = os.environ.get("JWT_SECRET_ARN")
    if not secret_arn:
        return None

    try:
        import boto3
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_arn)
        secret_value = response.get("SecretString", "")

        # The generated secret may be a JSON object or plain string
        try:
            parsed = json.loads(secret_value)
            # If it's a dict, extract the value (Secrets Manager generates {"password": "..."})
            if isinstance(parsed, dict):
                return parsed.get("password") or next(iter(parsed.values()), None)
            return str(parsed)
        except json.JSONDecodeError:
            return secret_value
    except Exception:
        return None


@dataclass
class Config:
    """Application configuration from environment variables."""

    # Aurora
    aurora_secret_arn: str = field(
        default_factory=lambda: os.environ.get("AURORA_SECRET_ARN", "")
    )
    aurora_cluster_arn: str = field(
        default_factory=lambda: os.environ.get("AURORA_CLUSTER_ARN", "")
    )
    aurora_database: str = field(
        default_factory=lambda: os.environ.get("AURORA_DATABASE", "envoy")
    )

    # OAuth (issuer derived from request context if not set)
    oauth_issuer: str = field(
        default_factory=lambda: os.environ.get("OAUTH_ISSUER", "")
    )
    jwt_secret_key: Optional[str] = field(default_factory=_get_jwt_secret)
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60
    refresh_token_expire_days: int = 30
    authorization_code_expire_minutes: int = 10

    # AWS
    aws_region: str = field(
        default_factory=lambda: os.environ.get("AWS_REGION", "us-east-1")
    )

    # Logging
    log_level: str = field(
        default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO")
    )

    @property
    def is_configured(self) -> bool:
        """Check if required configuration is present."""
        return bool(self.aurora_secret_arn and self.aurora_cluster_arn)

    def get_oauth_issuer(self, event: dict = None) -> str:
        """Get OAuth issuer URL, deriving from request context if not configured."""
        if self.oauth_issuer:
            return self.oauth_issuer
        if event and "requestContext" in event:
            domain = event["requestContext"].get("domainName", "")
            stage = event["requestContext"].get("stage", "")
            if domain:
                if stage and stage != "$default":
                    return f"https://{domain}/{stage}"
                return f"https://{domain}"
        return ""


# Singleton instance
config = Config()

"""Configuration management for Envoy."""

import os
from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    environment: str = "dev"
    log_level: str = "INFO"

    # Database
    db_proxy_endpoint: str = ""
    db_name: str = "envoy"
    db_user: str = "envoy_app"
    db_password: str = ""
    db_port: int = 5432

    # JWT Authentication
    jwt_public_key: str = ""
    jwt_issuer: str = ""
    jwt_audience: str = "envoy-api"

    # AWS
    aws_region: str = "us-east-1"

    class Config:
        env_prefix = ""
        case_sensitive = False


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()

"""Pytest configuration and fixtures."""

import os
import sys
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import pytest

# Add shared layer to path for testing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "layers", "shared", "python"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "functions", "api"))


@pytest.fixture
def mock_db_connection():
    """Mock database connection."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    conn.fetch = AsyncMock(return_value=[])
    conn.fetchval = AsyncMock(return_value=None)
    conn.execute = AsyncMock(return_value="OK")
    return conn


@pytest.fixture
def mock_agentplane_client():
    """Mock AgentPlane client."""
    client = MagicMock()
    client.invoke_skill = AsyncMock(return_value={"result": "success"})
    client.generate_content = AsyncMock(return_value={"subject": "Test", "body": "Test body"})
    return client


@pytest.fixture
def mock_ses_client():
    """Mock SES client."""
    client = MagicMock()
    client.send_email = AsyncMock(return_value={"success": True, "message_id": "test-123"})
    return client


@pytest.fixture
def sample_target():
    """Sample target data."""
    return {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "organization_id": "550e8400-e29b-41d4-a716-446655440001",
        "email": "test@example.com",
        "first_name": "John",
        "last_name": "Doe",
        "company": "Test Corp",
        "target_type_id": None,
        "segment_id": None,
        "lifecycle_stage": 0,
        "custom_fields": {},
        "status": "active",
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
    }


@pytest.fixture
def sample_content():
    """Sample content data."""
    return {
        "id": "550e8400-e29b-41d4-a716-446655440002",
        "organization_id": "550e8400-e29b-41d4-a716-446655440001",
        "name": "Welcome Email",
        "content_type": "educational",
        "channel": "email",
        "subject": "Welcome to Our Service",
        "body": "<p>Welcome!</p>",
        "target_type_id": None,
        "segment_id": None,
        "lifecycle_stage": 0,
        "status": "active",
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
    }


@pytest.fixture
def sample_campaign():
    """Sample campaign data."""
    return {
        "id": "550e8400-e29b-41d4-a716-446655440003",
        "organization_id": "550e8400-e29b-41d4-a716-446655440001",
        "name": "Welcome Campaign",
        "status": "draft",
        "target_criteria": {},
        "skills": {},
        "scheduled_at": None,
        "started_at": None,
        "completed_at": None,
        "settings": {},
        "stats": {},
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
    }

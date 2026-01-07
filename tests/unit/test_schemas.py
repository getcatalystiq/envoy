"""Tests for Pydantic schemas."""

import pytest
from pydantic import ValidationError

# Import will work after path setup in conftest
from app.schemas import TargetCreate, TargetUpdate, ContentCreate, CampaignCreate


class TestTargetSchemas:
    """Tests for target schemas."""

    def test_target_create_valid(self):
        """Test valid target creation."""
        target = TargetCreate(
            email="test@example.com",
            first_name="John",
            last_name="Doe",
        )
        assert target.email == "test@example.com"
        assert target.lifecycle_stage == 0

    def test_target_create_invalid_email(self):
        """Test invalid email validation."""
        with pytest.raises(ValidationError):
            TargetCreate(email="invalid-email")

    def test_target_create_invalid_lifecycle_stage(self):
        """Test lifecycle stage bounds."""
        with pytest.raises(ValidationError):
            TargetCreate(email="test@example.com", lifecycle_stage=10)

    def test_target_update_valid_status(self):
        """Test valid status update."""
        update = TargetUpdate(status="unsubscribed")
        assert update.status == "unsubscribed"

    def test_target_update_invalid_status(self):
        """Test invalid status validation."""
        with pytest.raises(ValidationError):
            TargetUpdate(status="invalid")


class TestContentSchemas:
    """Tests for content schemas."""

    def test_content_create_valid(self):
        """Test valid content creation."""
        content = ContentCreate(
            name="Welcome Email",
            content_type="educational",
            body="<p>Welcome!</p>",
        )
        assert content.name == "Welcome Email"
        assert content.channel == "email"

    def test_content_create_invalid_type(self):
        """Test invalid content type validation."""
        with pytest.raises(ValidationError):
            ContentCreate(
                name="Test",
                content_type="invalid_type",
                body="test",
            )


class TestCampaignSchemas:
    """Tests for campaign schemas."""

    def test_campaign_create_valid(self):
        """Test valid campaign creation."""
        campaign = CampaignCreate(name="Welcome Campaign")
        assert campaign.name == "Welcome Campaign"
        assert campaign.target_criteria == {}

    def test_campaign_create_empty_name(self):
        """Test empty name validation."""
        with pytest.raises(ValidationError):
            CampaignCreate(name="")

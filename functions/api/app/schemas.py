"""Pydantic schemas for Envoy API."""

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


# Target schemas
class TargetCreate(BaseModel):
    """Schema for creating a target."""

    email: EmailStr
    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)
    company: Optional[str] = Field(None, max_length=255)
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None
    lifecycle_stage: int = Field(default=0, ge=0, le=6)
    custom_fields: dict[str, Any] = Field(default_factory=dict)


class TargetUpdate(BaseModel):
    """Schema for updating a target."""

    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)
    company: Optional[str] = Field(None, max_length=255)
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None
    lifecycle_stage: Optional[int] = Field(None, ge=0, le=6)
    status: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v and v not in ("active", "unsubscribed", "bounced"):
            raise ValueError("Invalid status")
        return v


class TargetResponse(BaseModel):
    """Schema for target response."""

    id: UUID
    organization_id: UUID
    email: str
    first_name: Optional[str]
    last_name: Optional[str]
    company: Optional[str]
    phone: Optional[str] = None
    phone_normalized: Optional[str] = None
    target_type_id: Optional[UUID]
    segment_id: Optional[UUID]
    lifecycle_stage: int
    custom_fields: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# Content schemas
class ContentCreate(BaseModel):
    """Schema for creating content."""

    name: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., pattern="^(educational|case_study|promotional|objection_handling|product_update)$")
    channel: str = Field(default="email", pattern="^(email|linkedin|twitter|blog|instagram)$")
    subject: Optional[str] = Field(None, max_length=500)
    body: str = Field(..., min_length=1)
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None
    lifecycle_stage: Optional[int] = Field(None, ge=0, le=6)


class ContentUpdate(BaseModel):
    """Schema for updating content."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    content_type: Optional[str] = Field(None, pattern="^(educational|case_study|promotional|objection_handling|product_update)$")
    channel: Optional[str] = Field(None, pattern="^(email|linkedin|twitter|blog|instagram)$")
    subject: Optional[str] = Field(None, max_length=500)
    body: Optional[str] = Field(None, min_length=1)
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None
    lifecycle_stage: Optional[int] = Field(None, ge=0, le=6)
    status: Optional[str] = Field(None, pattern="^(draft|active|archived)$")


class ContentResponse(BaseModel):
    """Schema for content response."""

    id: UUID
    name: str
    content_type: str
    channel: str
    subject: Optional[str]
    body: str
    target_type_id: Optional[UUID]
    segment_id: Optional[UUID]
    lifecycle_stage: Optional[int]
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ContentGenerate(BaseModel):
    """Schema for AI content generation request."""

    target_id: UUID
    content_type: str = Field(..., pattern="^(educational|case_study|promotional)$")
    channel: str = Field(default="email", pattern="^(email|linkedin|twitter)$")


class ContentGenerateToOutbox(BaseModel):
    """Schema for generating content and sending to outbox for review."""

    target_id: UUID
    content_type: str = Field(..., pattern="^(educational|case_study|promotional|objection_handling|product_update)$")
    channel: str = Field(default="email", pattern="^(email|linkedin|sms)$")
    priority: int = Field(default=5, ge=1, le=10)


# Campaign schemas
class CampaignCreate(BaseModel):
    """Schema for creating a campaign."""

    name: str = Field(..., min_length=1, max_length=255)
    target_criteria: dict[str, Any] = Field(default_factory=dict)
    skills: dict[str, Any] = Field(default_factory=dict)
    scheduled_at: Optional[datetime] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class CampaignUpdate(BaseModel):
    """Schema for updating a campaign."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    target_criteria: Optional[dict[str, Any]] = None
    skills: Optional[dict[str, Any]] = None
    scheduled_at: Optional[datetime] = None
    settings: Optional[dict[str, Any]] = None
    status: Optional[str] = Field(None, pattern="^(draft|scheduled|active|paused|completed)$")


class CampaignResponse(BaseModel):
    """Schema for campaign response."""

    id: UUID
    name: str
    status: str
    target_criteria: dict[str, Any]
    skills: dict[str, Any]
    scheduled_at: Optional[datetime]
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    settings: dict[str, Any]
    stats: dict[str, Any]
    maven_session_id: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# Send schemas
class SendRequest(BaseModel):
    """Schema for sending content."""

    target_id: UUID
    content_id: Optional[UUID] = None
    campaign_id: Optional[UUID] = None
    subject: Optional[str] = Field(None, max_length=500)
    body: Optional[str] = None


class SendResponse(BaseModel):
    """Schema for send response."""

    id: UUID
    email: str
    status: str
    ses_message_id: Optional[str]
    sent_at: Optional[datetime]


# Analytics schemas
class AnalyticsQuery(BaseModel):
    """Schema for analytics query."""

    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    campaign_id: Optional[UUID] = None
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None


class AnalyticsResponse(BaseModel):
    """Schema for analytics response."""

    total_sent: int
    delivered: int
    opened: int
    clicked: int
    bounced: int
    delivery_rate: float
    open_rate: float
    click_rate: float
    bounce_rate: float


# Outbox schemas
class OutboxCreate(BaseModel):
    """Schema for creating an outbox item."""

    target_id: UUID
    channel: str = Field(..., pattern="^(email|linkedin|sms)$")
    subject: Optional[str] = Field(None, max_length=500)
    body: str = Field(..., min_length=1)
    skill_name: str = Field(..., min_length=1, max_length=100)
    skill_reasoning: Optional[str] = None
    confidence_score: Optional[float] = Field(None, ge=0, le=1)
    priority: int = Field(default=5, ge=1, le=10)
    scheduled_for: Optional[datetime] = None


class OutboxUpdate(BaseModel):
    """Schema for updating an outbox item."""

    subject: Optional[str] = Field(None, max_length=500)
    body: Optional[str] = Field(None, min_length=1)
    priority: Optional[int] = Field(None, ge=1, le=10)
    scheduled_for: Optional[datetime] = None


class OutboxApprove(BaseModel):
    """Schema for approving outbox items."""

    pass


class OutboxReject(BaseModel):
    """Schema for rejecting an outbox item."""

    reason: Optional[str] = Field(None, max_length=500)


class OutboxSnooze(BaseModel):
    """Schema for snoozing an outbox item."""

    snooze_until: datetime


class OutboxResponse(BaseModel):
    """Schema for outbox response."""

    id: UUID
    target_id: UUID
    channel: str
    subject: Optional[str]
    body: str
    skill_name: str
    skill_reasoning: Optional[str]
    confidence_score: Optional[float]
    status: str
    priority: int
    scheduled_for: Optional[datetime]
    snooze_until: Optional[datetime]
    reviewed_by: Optional[UUID]
    reviewed_at: Optional[datetime]
    rejection_reason: Optional[str]
    edit_history: list[dict[str, Any]]
    send_result: Optional[dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    created_by: Optional[UUID]

    model_config = {"from_attributes": True}


class OutboxWithTarget(OutboxResponse):
    """Outbox response with target details."""

    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    company: Optional[str] = None


class OutboxStats(BaseModel):
    """Schema for outbox statistics."""

    pending: int = 0
    approved: int = 0
    rejected: int = 0
    snoozed: int = 0
    sent: int = 0
    failed: int = 0


# List response wrapper
class ListResponse(BaseModel):
    """Generic list response with pagination."""

    items: list[Any]
    total: int
    limit: int
    offset: int

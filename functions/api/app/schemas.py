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
    email: str
    first_name: Optional[str]
    last_name: Optional[str]
    company: Optional[str]
    target_type_id: Optional[UUID]
    segment_id: Optional[UUID]
    lifecycle_stage: int
    custom_fields: dict[str, Any]
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


# List response wrapper
class ListResponse(BaseModel):
    """Generic list response with pagination."""

    items: list[Any]
    total: int
    limit: int
    offset: int

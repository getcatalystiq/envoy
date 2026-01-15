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

    email: Optional[EmailStr] = None
    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)
    company: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    target_type_id: Optional[UUID] = None
    segment_id: Optional[UUID] = None
    lifecycle_stage: Optional[int] = Field(None, ge=0, le=6)
    custom_fields: Optional[dict[str, Any]] = None
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

    @field_validator("send_result", mode="before")
    @classmethod
    def parse_send_result(cls, v: Any) -> Optional[dict[str, Any]]:
        """Parse send_result from JSON string if needed."""
        if v is None:
            return None
        if isinstance(v, str):
            import json
            return json.loads(v)
        return v

    @field_validator("edit_history", mode="before")
    @classmethod
    def parse_edit_history(cls, v: Any) -> list[dict[str, Any]]:
        """Parse edit_history from JSON string if needed."""
        if v is None:
            return []
        if isinstance(v, str):
            import json
            return json.loads(v)
        return v


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


# Sequence schemas
class SequenceCreate(BaseModel):
    """Schema for creating a sequence."""

    name: str = Field(..., min_length=1, max_length=255)
    target_type_id: Optional[UUID] = None
    status: str = Field(default="draft", pattern="^(draft|active|archived)$")


class SequenceUpdate(BaseModel):
    """Schema for updating a sequence."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[str] = Field(None, pattern="^(draft|active|archived)$")


class SequenceStepContentResponse(BaseModel):
    """Schema for step content in response."""

    id: UUID
    content_id: UUID
    priority: int
    content_name: Optional[str] = None
    content_subject: Optional[str] = None

    model_config = {"from_attributes": True}


class SequenceStepResponse(BaseModel):
    """Schema for step in response."""

    id: UUID
    position: int
    default_delay_hours: int
    contents: list[SequenceStepContentResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class SequenceResponse(BaseModel):
    """Schema for sequence response."""

    id: UUID
    organization_id: UUID
    name: str
    target_type_id: UUID
    status: str
    steps: list[SequenceStepResponse] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SequenceStepCreate(BaseModel):
    """Schema for creating a sequence step."""

    position: int = Field(..., ge=1)
    default_delay_hours: int = Field(default=24, ge=0)


class SequenceStepUpdate(BaseModel):
    """Schema for updating a sequence step."""

    position: Optional[int] = Field(None, ge=1)
    default_delay_hours: Optional[int] = Field(None, ge=0)


class SequenceStepContentCreate(BaseModel):
    """Schema for adding content to a step."""

    content_id: UUID
    priority: int = Field(default=1, ge=1)


class EnrollmentCreate(BaseModel):
    """Schema for enrolling a target in a sequence."""

    target_id: UUID
    first_step_delay_hours: int = Field(default=0, ge=0)


class EnrollmentResponse(BaseModel):
    """Schema for enrollment response."""

    id: UUID
    organization_id: UUID
    target_id: UUID
    sequence_id: UUID
    current_step_position: int
    status: str
    exit_reason: Optional[str]
    enrolled_at: datetime
    last_step_completed_at: Optional[datetime]
    next_evaluation_at: Optional[datetime]
    paused_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    sequence_name: Optional[str] = None
    target_email: Optional[str] = None

    model_config = {"from_attributes": True}


class StepExecutionResponse(BaseModel):
    """Schema for step execution response."""

    id: UUID
    enrollment_id: UUID
    step_position: int
    executed_at: datetime
    content_id: Optional[UUID]
    email_send_id: Optional[UUID]
    status: str
    created_at: datetime
    content_name: Optional[str] = None

    model_config = {"from_attributes": True}


# List response wrapper
class ListResponse(BaseModel):
    """Generic list response with pagination."""

    items: list[Any]
    total: int
    limit: int
    offset: int


# Design Template schemas
class DesignTemplateCreate(BaseModel):
    """Schema for creating a design template."""

    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    editor_type: str = Field(default="maily")  # "mjml" or "maily"
    mjml_source: Optional[str] = Field(None, min_length=1)
    maily_content: Optional[dict] = None  # Maily/Tiptap JSON content


class DesignTemplateUpdate(BaseModel):
    """Schema for updating a design template."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    mjml_source: Optional[str] = Field(None, min_length=1)
    maily_content: Optional[dict] = None
    archived: Optional[bool] = None


class DesignTemplateResponse(BaseModel):
    """Schema for design template response."""

    id: UUID
    organization_id: UUID
    name: str
    description: Optional[str] = None
    editor_type: str = "mjml"
    mjml_source: Optional[str] = None
    maily_content: Optional[dict] = None
    html_compiled: Optional[str] = None
    archived: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DesignTemplatePreviewRequest(BaseModel):
    """Schema for design template preview request."""

    mjml_source: Optional[str] = Field(None, min_length=1)
    maily_content: Optional[dict] = None
    sample_data: Optional[dict[str, str]] = None


class DesignTemplatePreviewResponse(BaseModel):
    """Schema for design template preview response."""

    html: str
    text: str
    errors: Optional[list[str]] = None


# Target Type schemas
class TargetTypeCreate(BaseModel):
    """Schema for creating a target type."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)


class TargetTypeUpdate(BaseModel):
    """Schema for updating a target type."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None


class TargetTypeResponse(BaseModel):
    """Schema for target type response."""

    id: UUID
    organization_id: UUID
    name: str
    description: Optional[str] = None
    lifecycle_stages: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime

    model_config = {"from_attributes": True}


class TargetTypeUsageCount(BaseModel):
    """Schema for target type usage count."""

    segments: int = 0
    targets: int = 0
    sequences: int = 0
    content: int = 0


# Segment schemas
class SegmentCreate(BaseModel):
    """Schema for creating a segment."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    target_type_id: UUID
    pain_points: Optional[list[str]] = None
    objections: Optional[list[str]] = None


class SegmentUpdate(BaseModel):
    """Schema for updating a segment."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    target_type_id: Optional[UUID] = None
    pain_points: Optional[list[str]] = None
    objections: Optional[list[str]] = None


class SegmentResponse(BaseModel):
    """Schema for segment response."""

    id: UUID
    organization_id: UUID
    target_type_id: UUID
    target_type_name: Optional[str] = None
    name: str
    description: Optional[str] = None
    pain_points: list[str] = Field(default_factory=list)
    objections: list[str] = Field(default_factory=list)
    created_at: datetime

    model_config = {"from_attributes": True}


class SegmentUsageCount(BaseModel):
    """Schema for segment usage count."""

    targets: int = 0
    content: int = 0


# Organization schemas
class OrganizationUpdate(BaseModel):
    """Schema for updating organization settings."""

    email_domain: Optional[str] = Field(None, max_length=255)
    email_from_name: Optional[str] = Field(None, max_length=100)

    @field_validator("email_domain")
    @classmethod
    def validate_domain(cls, v: Optional[str]) -> Optional[str]:
        if v:
            # Basic domain validation
            import re

            if not re.match(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", v.lower()):
                raise ValueError("Invalid domain format")
            return v.lower()
        return v


class DNSRecord(BaseModel):
    """Schema for DNS record."""

    type: str
    name: str
    value: str


class OrganizationResponse(BaseModel):
    """Schema for organization response."""

    id: UUID
    name: str
    email_domain: Optional[str] = None
    email_domain_verified: bool = False
    email_from_name: Optional[str] = None
    dns_records: list[DNSRecord] = Field(default_factory=list)

    model_config = {"from_attributes": True}

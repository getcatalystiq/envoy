import { z } from "zod";

// ---------------------------------------------------------------------------
// Target schemas
// ---------------------------------------------------------------------------

export const targetCreateSchema = z.object({
  email: z.string().email(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  company: z.string().max(255).nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  segment_id: z.string().uuid().nullable().optional(),
  lifecycle_stage: z.number().int().min(0).max(6).default(0),
  custom_fields: z.record(z.unknown()).default({}),
});
export type TargetCreate = z.infer<typeof targetCreateSchema>;

export const targetUpdateSchema = z.object({
  email: z.string().email().nullable().optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  company: z.string().max(255).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  segment_id: z.string().uuid().nullable().optional(),
  lifecycle_stage: z.number().int().min(0).max(6).nullable().optional(),
  custom_fields: z.record(z.unknown()).nullable().optional(),
  status: z
    .enum(["active", "unsubscribed", "bounced"])
    .nullable()
    .optional(),
});
export type TargetUpdate = z.infer<typeof targetUpdateSchema>;

export const targetResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  company: z.string().nullable(),
  phone: z.string().nullable().optional(),
  phone_normalized: z.string().nullable().optional(),
  target_type_id: z.string().uuid().nullable(),
  segment_id: z.string().uuid().nullable(),
  lifecycle_stage: z.number().int(),
  custom_fields: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
  status: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type TargetResponse = z.infer<typeof targetResponseSchema>;

// ---------------------------------------------------------------------------
// Content schemas
// ---------------------------------------------------------------------------

export const contentCreateSchema = z.object({
  name: z.string().min(1).max(255),
  content_type: z.enum([
    "educational",
    "case_study",
    "promotional",
    "objection_handling",
    "product_update",
  ]),
  channel: z
    .enum(["email", "linkedin", "twitter", "blog", "instagram"])
    .default("email"),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1),
  target_type_id: z.string().uuid().nullable().optional(),
  segment_id: z.string().uuid().nullable().optional(),
  lifecycle_stage: z.number().int().min(0).max(6).nullable().optional(),
});
export type ContentCreate = z.infer<typeof contentCreateSchema>;

export const contentUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  content_type: z
    .enum([
      "educational",
      "case_study",
      "promotional",
      "objection_handling",
      "product_update",
    ])
    .nullable()
    .optional(),
  channel: z
    .enum(["email", "linkedin", "twitter", "blog", "instagram"])
    .nullable()
    .optional(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  segment_id: z.string().uuid().nullable().optional(),
  lifecycle_stage: z.number().int().min(0).max(6).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).nullable().optional(),
});
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

export const contentResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  content_type: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  target_type_id: z.string().uuid().nullable(),
  segment_id: z.string().uuid().nullable(),
  lifecycle_stage: z.number().int().nullable(),
  status: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ContentResponse = z.infer<typeof contentResponseSchema>;

export const contentGenerateSchema = z.object({
  target_id: z.string().uuid(),
  content_type: z.enum(["educational", "case_study", "promotional"]),
  channel: z.enum(["email", "linkedin", "twitter"]).default("email"),
});
export type ContentGenerate = z.infer<typeof contentGenerateSchema>;

export const contentGenerateToOutboxSchema = z.object({
  target_id: z.string().uuid(),
  content_type: z.enum([
    "educational",
    "case_study",
    "promotional",
    "objection_handling",
    "product_update",
  ]),
  channel: z.enum(["email", "linkedin", "sms"]).default("email"),
  priority: z.number().int().min(1).max(10).default(5),
});
export type ContentGenerateToOutbox = z.infer<
  typeof contentGenerateToOutboxSchema
>;

// ---------------------------------------------------------------------------
// Campaign schemas
// ---------------------------------------------------------------------------

export const campaignCreateSchema = z.object({
  name: z.string().min(1).max(255),
  target_criteria: z.record(z.unknown()).default({}),
  skills: z.record(z.unknown()).default({}),
  scheduled_at: z.string().datetime().nullable().optional(),
  settings: z.record(z.unknown()).default({}),
});
export type CampaignCreate = z.infer<typeof campaignCreateSchema>;

export const campaignUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  target_criteria: z.record(z.unknown()).nullable().optional(),
  skills: z.record(z.unknown()).nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  settings: z.record(z.unknown()).nullable().optional(),
  status: z
    .enum(["draft", "scheduled", "active", "paused", "completed"])
    .nullable()
    .optional(),
});
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;

export const campaignResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  target_criteria: z.record(z.unknown()),
  skills: z.record(z.unknown()),
  scheduled_at: z.string().datetime().nullable(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  settings: z.record(z.unknown()),
  stats: z.record(z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type CampaignResponse = z.infer<typeof campaignResponseSchema>;

// ---------------------------------------------------------------------------
// Send schemas
// ---------------------------------------------------------------------------

export const sendRequestSchema = z.object({
  target_id: z.string().uuid(),
  content_id: z.string().uuid().nullable().optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().nullable().optional(),
});
export type SendRequest = z.infer<typeof sendRequestSchema>;

export const sendResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  status: z.string(),
  ses_message_id: z.string().nullable(),
  sent_at: z.string().datetime().nullable(),
});
export type SendResponse = z.infer<typeof sendResponseSchema>;

// ---------------------------------------------------------------------------
// Analytics schemas
// ---------------------------------------------------------------------------

export const analyticsQuerySchema = z.object({
  start_date: z.string().datetime().nullable().optional(),
  end_date: z.string().datetime().nullable().optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  segment_id: z.string().uuid().nullable().optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const analyticsResponseSchema = z.object({
  total_sent: z.number().int(),
  delivered: z.number().int(),
  opened: z.number().int(),
  clicked: z.number().int(),
  bounced: z.number().int(),
  delivery_rate: z.number(),
  open_rate: z.number(),
  click_rate: z.number(),
  bounce_rate: z.number(),
});
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

export const metricsDataPointSchema = z.object({
  timestamp: z.string().datetime(),
  sent: z.number().int(),
  delivered: z.number().int(),
  transient_bounces: z.number().int(),
  permanent_bounces: z.number().int(),
  complaints: z.number().int(),
  opens: z.number().int(),
  clicks: z.number().int(),
});
export type MetricsDataPoint = z.infer<typeof metricsDataPointSchema>;

export const metricsMetadataSchema = z.object({
  granularity: z.string(),
  start_date: z.string(),
  end_date: z.string(),
});
export type MetricsMetadata = z.infer<typeof metricsMetadataSchema>;

export const metricsTimeSeriesResponseSchema = z.object({
  data: z.array(metricsDataPointSchema),
  meta: metricsMetadataSchema,
});
export type MetricsTimeSeriesResponse = z.infer<
  typeof metricsTimeSeriesResponseSchema
>;

// ---------------------------------------------------------------------------
// Outbox schemas
// ---------------------------------------------------------------------------

export const outboxCreateSchema = z.object({
  target_id: z.string().uuid(),
  channel: z.enum(["email", "linkedin", "sms"]),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1),
  confidence_score: z.number().min(0).max(1).nullable().optional(),
  priority: z.number().int().min(1).max(10).default(5),
  scheduled_for: z.string().datetime().nullable().optional(),
});
export type OutboxCreate = z.infer<typeof outboxCreateSchema>;

export const outboxUpdateSchema = z.object({
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).nullable().optional(),
  priority: z.number().int().min(1).max(10).nullable().optional(),
  scheduled_for: z.string().datetime().nullable().optional(),
});
export type OutboxUpdate = z.infer<typeof outboxUpdateSchema>;

export const outboxApproveSchema = z.object({});
export type OutboxApprove = z.infer<typeof outboxApproveSchema>;

export const outboxRejectSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});
export type OutboxReject = z.infer<typeof outboxRejectSchema>;

export const outboxSnoozeSchema = z.object({
  snooze_until: z.string().datetime(),
});
export type OutboxSnooze = z.infer<typeof outboxSnoozeSchema>;

export const outboxResponseSchema = z.object({
  id: z.string().uuid(),
  target_id: z.string().uuid(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  confidence_score: z.number().nullable(),
  status: z.string(),
  priority: z.number().int(),
  scheduled_for: z.string().datetime().nullable(),
  snooze_until: z.string().datetime().nullable(),
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string().datetime().nullable(),
  rejection_reason: z.string().nullable(),
  edit_history: z.array(z.record(z.unknown())),
  send_result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string().uuid().nullable(),
});
export type OutboxResponse = z.infer<typeof outboxResponseSchema>;

export const outboxWithTargetSchema = outboxResponseSchema.extend({
  email: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  delivered_at: z.string().datetime().nullable().optional(),
  opened_at: z.string().datetime().nullable().optional(),
  clicked_at: z.string().datetime().nullable().optional(),
  bounced_at: z.string().datetime().nullable().optional(),
  complained_at: z.string().datetime().nullable().optional(),
});
export type OutboxWithTarget = z.infer<typeof outboxWithTargetSchema>;

export const outboxStatsSchema = z.object({
  pending: z.number().int().default(0),
  approved: z.number().int().default(0),
  rejected: z.number().int().default(0),
  snoozed: z.number().int().default(0),
  sent: z.number().int().default(0),
  failed: z.number().int().default(0),
});
export type OutboxStats = z.infer<typeof outboxStatsSchema>;

// ---------------------------------------------------------------------------
// Sequence schemas
// ---------------------------------------------------------------------------

export const sequenceCreateSchema = z.object({
  name: z.string().min(1).max(255),
  target_type_id: z.string().uuid().nullable().optional(),
  status: z
    .enum(["draft", "active", "paused", "archived"])
    .default("draft"),
  is_default: z.boolean().default(false),
});
export type SequenceCreate = z.infer<typeof sequenceCreateSchema>;

export const sequenceUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  status: z
    .enum(["draft", "active", "paused", "archived"])
    .nullable()
    .optional(),
  is_default: z.boolean().nullable().optional(),
});
export type SequenceUpdate = z.infer<typeof sequenceUpdateSchema>;

export const sequenceStepResponseSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  default_delay_hours: z.number().int(),
  subject: z.string().nullable().optional(),
  builder_content: z.record(z.unknown()).nullable().optional(),
  has_unpublished_changes: z.boolean().default(false),
  approval_required: z.boolean().default(true),
});
export type SequenceStepResponse = z.infer<
  typeof sequenceStepResponseSchema
>;

export const sequenceResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  name: z.string(),
  target_type_id: z.string().uuid().nullable().optional(),
  status: z.string(),
  is_default: z.boolean().default(false),
  steps: z.array(sequenceStepResponseSchema).default([]),
  step_count: z.number().int().default(0),
  total_duration_days: z.number().int().default(0),
  total_enrollments: z.number().int().default(0),
  active_enrollments: z.number().int().default(0),
  exited_enrollments: z.number().int().default(0),
  open_rate: z.number().default(0),
  click_rate: z.number().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type SequenceResponse = z.infer<typeof sequenceResponseSchema>;

export const sequenceStepCreateSchema = z.object({
  position: z.number().int().min(1),
  default_delay_hours: z.number().int().min(0).default(24),
  subject: z.string().max(998).nullable().optional(),
});
export type SequenceStepCreate = z.infer<typeof sequenceStepCreateSchema>;

export const sequenceStepUpdateSchema = z.object({
  position: z.number().int().min(1).nullable().optional(),
  default_delay_hours: z.number().int().min(0).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  builder_content: z.record(z.unknown()).nullable().optional(),
  has_unpublished_changes: z.boolean().nullable().optional(),
  approval_required: z.boolean().nullable().optional(),
});
export type SequenceStepUpdate = z.infer<typeof sequenceStepUpdateSchema>;

export const enrollmentCreateSchema = z.object({
  target_id: z.string().uuid(),
  first_step_delay_hours: z.number().int().min(0).nullable().optional(),
});
export type EnrollmentCreate = z.infer<typeof enrollmentCreateSchema>;

export const enrollmentResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  target_id: z.string().uuid(),
  sequence_id: z.string().uuid(),
  current_step_position: z.number().int(),
  status: z.string(),
  exit_reason: z.string().nullable(),
  enrolled_at: z.string().datetime(),
  last_step_completed_at: z.string().datetime().nullable(),
  next_evaluation_at: z.string().datetime().nullable(),
  paused_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  sequence_name: z.string().nullable().optional(),
  target_email: z.string().nullable().optional(),
});
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;

export const stepExecutionResponseSchema = z.object({
  id: z.string().uuid(),
  enrollment_id: z.string().uuid(),
  step_position: z.number().int(),
  executed_at: z.string().datetime(),
  content_id: z.string().uuid().nullable(),
  email_send_id: z.string().uuid().nullable(),
  status: z.string(),
  created_at: z.string().datetime(),
  content_name: z.string().nullable().optional(),
});
export type StepExecutionResponse = z.infer<
  typeof stepExecutionResponseSchema
>;

// ---------------------------------------------------------------------------
// List response wrapper
// ---------------------------------------------------------------------------

export const listResponseSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListResponse = z.infer<typeof listResponseSchema>;

// ---------------------------------------------------------------------------
// Design Template schemas
// ---------------------------------------------------------------------------

export const designTemplateCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  builder_content: z.record(z.unknown()).nullable().optional(),
});
export type DesignTemplateCreate = z.infer<
  typeof designTemplateCreateSchema
>;

export const designTemplateUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  description: z.string().nullable().optional(),
  builder_content: z.record(z.unknown()).nullable().optional(),
  html_compiled: z.string().nullable().optional(),
  archived: z.boolean().nullable().optional(),
});
export type DesignTemplateUpdate = z.infer<
  typeof designTemplateUpdateSchema
>;

export const designTemplateResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  builder_content: z.record(z.unknown()).nullable().optional(),
  html_compiled: z.string().nullable().optional(),
  archived: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type DesignTemplateResponse = z.infer<
  typeof designTemplateResponseSchema
>;

export const designTemplatePreviewRequestSchema = z.object({
  builder_content: z.record(z.unknown()).nullable().optional(),
  sample_data: z.record(z.string()).nullable().optional(),
});
export type DesignTemplatePreviewRequest = z.infer<
  typeof designTemplatePreviewRequestSchema
>;

export const designTemplatePreviewResponseSchema = z.object({
  html: z.string(),
  text: z.string(),
  errors: z.array(z.string()).nullable().optional(),
});
export type DesignTemplatePreviewResponse = z.infer<
  typeof designTemplatePreviewResponseSchema
>;

// ---------------------------------------------------------------------------
// Target Type schemas
// ---------------------------------------------------------------------------

export const targetTypeCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
});
export type TargetTypeCreate = z.infer<typeof targetTypeCreateSchema>;

export const targetTypeUpdateSchema = z.object({
  name: z.string().min(1).max(100).nullable().optional(),
  description: z.string().nullable().optional(),
});
export type TargetTypeUpdate = z.infer<typeof targetTypeUpdateSchema>;

export const targetTypeResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  lifecycle_stages: z.array(z.record(z.unknown())).default([]),
  created_at: z.string().datetime(),
});
export type TargetTypeResponse = z.infer<typeof targetTypeResponseSchema>;

export const targetTypeUsageCountSchema = z.object({
  segments: z.number().int().default(0),
  targets: z.number().int().default(0),
  sequences: z.number().int().default(0),
  content: z.number().int().default(0),
});
export type TargetTypeUsageCount = z.infer<
  typeof targetTypeUsageCountSchema
>;

// ---------------------------------------------------------------------------
// Segment schemas
// ---------------------------------------------------------------------------

export const segmentCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  target_type_id: z.string().uuid(),
  pain_points: z.array(z.string()).nullable().optional(),
  objections: z.array(z.string()).nullable().optional(),
});
export type SegmentCreate = z.infer<typeof segmentCreateSchema>;

export const segmentUpdateSchema = z.object({
  name: z.string().min(1).max(100).nullable().optional(),
  description: z.string().nullable().optional(),
  target_type_id: z.string().uuid().nullable().optional(),
  pain_points: z.array(z.string()).nullable().optional(),
  objections: z.array(z.string()).nullable().optional(),
});
export type SegmentUpdate = z.infer<typeof segmentUpdateSchema>;

export const segmentResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  target_type_id: z.string().uuid(),
  target_type_name: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  pain_points: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
});
export type SegmentResponse = z.infer<typeof segmentResponseSchema>;

export const segmentUsageCountSchema = z.object({
  targets: z.number().int().default(0),
  content: z.number().int().default(0),
});
export type SegmentUsageCount = z.infer<typeof segmentUsageCountSchema>;

// ---------------------------------------------------------------------------
// Organization schemas
// ---------------------------------------------------------------------------

export const organizationUpdateSchema = z.object({
  email_domain: z
    .string()
    .max(255)
    .regex(
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
    )
    .nullable()
    .optional(),
  email_from_name: z.string().max(100).nullable().optional(),
});
export type OrganizationUpdate = z.infer<typeof organizationUpdateSchema>;

export const dnsRecordSchema = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
});
export type DNSRecord = z.infer<typeof dnsRecordSchema>;

export const organizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email_domain: z.string().nullable().optional(),
  email_domain_verified: z.boolean().default(false),
  email_from_name: z.string().nullable().optional(),
  ses_tenant_name: z.string().nullable().optional(),
  ses_configuration_set: z.string().nullable().optional(),
  dns_records: z.array(dnsRecordSchema).default([]),
});
export type OrganizationResponse = z.infer<
  typeof organizationResponseSchema
>;

// ---------------------------------------------------------------------------
// Graduation schemas
// ---------------------------------------------------------------------------

export const ruleConditionSchema = z.object({
  field: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !v.includes("__") && !v.startsWith("_"), {
      message: "Invalid field name",
    })
    .refine((v) => (v.match(/\./g) || []).length <= 2, {
      message: "Field path too deep",
    }),
  operator: z.enum([
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "exists",
  ]),
  value: z.unknown().nullable().optional(),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const graduationRuleCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  source_target_type_id: z.string().uuid(),
  destination_target_type_id: z.string().uuid(),
  conditions: z.array(ruleConditionSchema).min(1).max(20),
  enabled: z.boolean().default(true),
});
export type GraduationRuleCreate = z.infer<
  typeof graduationRuleCreateSchema
>;

export const graduationRuleUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  description: z.string().nullable().optional(),
  conditions: z.array(ruleConditionSchema).nullable().optional(),
  enabled: z.boolean().nullable().optional(),
});
export type GraduationRuleUpdate = z.infer<
  typeof graduationRuleUpdateSchema
>;

export const graduationRuleResponseSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  source_target_type_id: z.string().uuid(),
  destination_target_type_id: z.string().uuid(),
  source_type_name: z.string().nullable().optional(),
  destination_type_name: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable(),
  conditions: z.array(z.record(z.unknown())),
  enabled: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type GraduationRuleResponse = z.infer<
  typeof graduationRuleResponseSchema
>;

export const manualGraduationRequestSchema = z.object({
  destination_target_type_id: z.string().uuid(),
});
export type ManualGraduationRequest = z.infer<
  typeof manualGraduationRequestSchema
>;

export const graduationEventResponseSchema = z.object({
  id: z.string().uuid(),
  target_id: z.string().uuid().nullable(),
  target_email: z.string().nullable().optional(),
  rule_id: z.string().uuid().nullable(),
  rule_name: z.string().nullable().optional(),
  source_target_type_id: z.string().uuid(),
  source_type_name: z.string(),
  destination_target_type_id: z.string().uuid(),
  destination_type_name: z.string(),
  manual: z.boolean(),
  triggered_by_user_id: z.string().uuid().nullable(),
  triggered_by_email: z.string().nullable().optional(),
  created_at: z.string().datetime(),
});
export type GraduationEventResponse = z.infer<
  typeof graduationEventResponseSchema
>;

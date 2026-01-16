import { getAccessToken, logout } from '@/auth/oauth';

const API_URL = import.meta.env.VITE_API_URL || '';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      window.location.href = '/login';
    }
    const error = await response.json().catch(() => ({ detail: 'Request failed' }));
    throw new Error(error.detail || 'Request failed');
  }

  // Handle 204 No Content responses
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  get: <T>(endpoint: string) => request<T>(endpoint),

  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, data: unknown) =>
    request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  patch: <T>(endpoint: string, data: unknown) =>
    request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: <T>(endpoint: string) =>
    request<T>(endpoint, { method: 'DELETE' }),
};

// API Types
export interface Target {
  id: string;
  organization_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  phone_normalized: string | null;
  target_type_id: string | null;
  segment_id: string | null;
  lifecycle_stage: number;
  custom_fields: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface LifecycleStage {
  stage: number;
  name: string;
  criteria: string;
}

export interface TargetType {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  lifecycle_stages: LifecycleStage[];
  created_at: string;
}

export interface TargetTypeCreate {
  name: string;
  description?: string;
}

export interface TargetTypeUpdate {
  name?: string;
  description?: string;
}

export interface TargetTypeUsageCount {
  segments: number;
  targets: number;
  sequences: number;
  content: number;
}

export interface Segment {
  id: string;
  organization_id: string;
  target_type_id: string;
  target_type_name: string | null;
  name: string;
  description: string | null;
  pain_points: string[];
  objections: string[];
  created_at: string;
}

export interface SegmentCreate {
  name: string;
  description?: string;
  target_type_id: string;
  pain_points?: string[];
  objections?: string[];
}

export interface SegmentUpdate {
  name?: string;
  description?: string;
  target_type_id?: string;
  pain_points?: string[];
  objections?: string[];
}

export interface SegmentUsageCount {
  targets: number;
  content: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  send_from_email: string;
  send_from_name: string;
  target_count: number;
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  replied_count: number;
  created_at: string;
}

export interface ContentTemplate {
  id: string;
  name: string;
  content_type: string;
  channel: string;
  subject: string | null;
  body: string;
  target_type_id: string | null;
  segment_id: string | null;
  lifecycle_stage: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Analytics {
  total_campaigns: number;
  total_targets: number;
  total_sent: number;
  total_opened: number;
  total_clicked: number;
  total_replied: number;
  open_rate: number;
  click_rate: number;
  reply_rate: number;
}

export interface OutboxItem {
  id: string;
  target_id: string;
  channel: string;
  subject: string | null;
  body: string;
  confidence_score: number | null;
  status: string;
  priority: number;
  scheduled_for: string | null;
  snooze_until: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  edit_history: Array<{
    timestamp: string;
    user_id: string;
    field: string;
    old_value: string;
    new_value: string;
  }>;
  send_result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  // Joined from target
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

export interface OutboxStats {
  pending: number;
  approved: number;
  rejected: number;
  snoozed: number;
  sent: number;
  failed: number;
}

// Sequence types
export type SequenceStatus = 'draft' | 'active' | 'archived';
export type EnrollmentStatus = 'active' | 'paused' | 'completed' | 'converted' | 'exited';

export interface Sequence {
  id: string;
  name: string;
  target_type_id: string | null;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
  steps?: SequenceStep[];
  step_count?: number;
  total_duration_days?: number;
  total_enrollments?: number;
  active_enrollments?: number;
  exited_enrollments?: number;
  open_rate?: number;
  click_rate?: number;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  position: number;
  default_delay_hours: number;
  subject: string | null;
  builder_content: BuilderContent | null;
  has_unpublished_changes?: boolean;
  created_at: string;
  updated_at?: string;
}

export interface Enrollment {
  id: string;
  target_id: string;
  sequence_id: string;
  status: EnrollmentStatus;
  current_step_position: number;
  enrolled_at: string;
  next_evaluation_at: string | null;
  completed_at: string | null;
  exit_reason: string | null;
  target_email?: string;
  target_name?: string;
  sequence_name?: string;
  total_steps?: number;
}

export interface StepExecution {
  id: string;
  enrollment_id: string;
  step_position: number;
  content_id: string | null;
  email_send_id: string | null;
  status: 'executed' | 'skipped';
  executed_at: string;
}

export interface CreateSequenceInput {
  name: string;
  target_type_id?: string;
}

export interface UpdateSequenceInput {
  name?: string;
  status?: SequenceStatus;
}

export interface CreateStepInput {
  position: number;
  default_delay_hours: number;
  subject?: string;
  builder_content?: BuilderContent;
}

export interface UpdateStepInput {
  position?: number;
  default_delay_hours?: number;
  subject?: string;
  builder_content?: BuilderContent;
  has_unpublished_changes?: boolean;
}

// Design Template types
// Email builder JSON content type (TReaderDocument format)
export interface BuilderContent {
  [blockId: string]: {
    type: string;
    data: Record<string, unknown>;
  };
}

export interface DesignTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  builder_content: BuilderContent | null;
  html_compiled: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface DesignTemplateCreate {
  name: string;
  description?: string;
  builder_content?: BuilderContent;
}

export interface DesignTemplateUpdate {
  name?: string;
  description?: string;
  builder_content?: BuilderContent;
  html_compiled?: string;
  archived?: boolean;
}

// Design Template API functions
export async function listDesignTemplates(includeArchived = false): Promise<DesignTemplate[]> {
  const query = includeArchived ? '?include_archived=true' : '';
  return api.get<DesignTemplate[]>(`/design-templates${query}`);
}

export async function getDesignTemplate(id: string): Promise<DesignTemplate> {
  return api.get<DesignTemplate>(`/design-templates/${id}`);
}

export async function createDesignTemplate(data: DesignTemplateCreate): Promise<DesignTemplate> {
  return api.post<DesignTemplate>('/design-templates', data);
}

export async function updateDesignTemplate(id: string, data: DesignTemplateUpdate): Promise<DesignTemplate> {
  return api.patch<DesignTemplate>(`/design-templates/${id}`, data);
}

export async function deleteDesignTemplate(id: string): Promise<void> {
  await api.delete(`/design-templates/${id}`);
}

// Organization settings types
export interface DNSRecord {
  type: 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  email_domain: string | null;
  email_domain_verified: boolean;
  email_from_name: string | null;
  dns_records: DNSRecord[];
}

// Organization API functions
export async function getOrganization(): Promise<OrganizationSettings> {
  return api.get<OrganizationSettings>('/organization');
}

export async function updateOrganization(data: {
  email_domain?: string;
  email_from_name?: string;
}): Promise<OrganizationSettings> {
  return api.patch<OrganizationSettings>('/organization', data);
}

export async function checkDomainVerificationStatus(): Promise<OrganizationSettings> {
  return api.post<OrganizationSettings>('/organization/verify-domain');
}

// Target Type API functions
export async function listTargetTypes(): Promise<TargetType[]> {
  return api.get<TargetType[]>('/target-types');
}

export async function getTargetType(id: string): Promise<TargetType> {
  return api.get<TargetType>(`/target-types/${id}`);
}

export async function createTargetType(data: TargetTypeCreate): Promise<TargetType> {
  return api.post<TargetType>('/target-types', data);
}

export async function updateTargetType(id: string, data: TargetTypeUpdate): Promise<TargetType> {
  return api.patch<TargetType>(`/target-types/${id}`, data);
}

export async function deleteTargetType(id: string): Promise<void> {
  await api.delete(`/target-types/${id}`);
}

export async function getTargetTypeUsage(id: string): Promise<TargetTypeUsageCount> {
  return api.get<TargetTypeUsageCount>(`/target-types/${id}/usage`);
}

// Segment API functions
export async function listSegments(targetTypeId?: string): Promise<Segment[]> {
  const query = targetTypeId ? `?target_type_id=${targetTypeId}` : '';
  return api.get<Segment[]>(`/segments${query}`);
}

export async function getSegment(id: string): Promise<Segment> {
  return api.get<Segment>(`/segments/${id}`);
}

export async function createSegment(data: SegmentCreate): Promise<Segment> {
  return api.post<Segment>('/segments', data);
}

export async function updateSegment(id: string, data: SegmentUpdate): Promise<Segment> {
  return api.patch<Segment>(`/segments/${id}`, data);
}

export async function deleteSegment(id: string): Promise<void> {
  await api.delete(`/segments/${id}`);
}

export async function getSegmentUsage(id: string): Promise<SegmentUsageCount> {
  return api.get<SegmentUsageCount>(`/segments/${id}/usage`);
}

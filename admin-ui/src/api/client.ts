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
  skill_name: string;
  skill_reasoning: string | null;
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
  active_enrollments?: number;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  position: number;
  default_delay_hours: number;
  created_at: string;
  contents?: StepContent[];
}

export interface StepContent {
  id: string;
  step_id: string;
  content_id: string;
  priority: number;
  content_name?: string;
  content_subject?: string;
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
}

export interface UpdateStepInput {
  position?: number;
  default_delay_hours?: number;
}

export interface AddStepContentInput {
  content_id: string;
  priority: number;
}

// Design Template types
export type EditorType = 'mjml' | 'maily';

// Maily JSON content type (Tiptap format)
export interface MailyContent {
  type: 'doc';
  content: MailyNode[];
}

export interface MailyNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: MailyNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface DesignTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  editor_type: EditorType;
  mjml_source: string | null;
  maily_content: MailyContent | null;
  html_compiled: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface DesignTemplateCreate {
  name: string;
  description?: string;
  editor_type?: EditorType;
  mjml_source?: string;
  maily_content?: MailyContent;
}

export interface DesignTemplateUpdate {
  name?: string;
  description?: string;
  mjml_source?: string;
  maily_content?: MailyContent;
  archived?: boolean;
}

export interface DesignTemplatePreview {
  html: string;
  text: string;
  errors?: string[];
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

export async function previewDesignTemplate(
  mjmlSource: string,
  sampleData?: Record<string, string>
): Promise<DesignTemplatePreview> {
  return api.post<DesignTemplatePreview>('/design-templates/preview', {
    mjml_source: mjmlSource,
    sample_data: sampleData,
  });
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

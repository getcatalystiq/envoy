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
  subject_template: string;
  body_template: string;
  variant_label: string | null;
  is_active: boolean;
  created_at: string;
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

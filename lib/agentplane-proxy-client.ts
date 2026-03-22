'use client';
/**
 * Proxy client that implements the AgentPlaneClient interface
 * by routing all calls through our authenticated REST API.
 * This avoids exposing AgentPlane credentials to the browser.
 */
import type { AgentPlaneClient } from '@getcatalystiq/agent-plane-ui';
import { api } from '@/lib/api';

 
type Any = any;

export function createProxyClient(): AgentPlaneClient {
  return {
    agents: {
      list: () =>
        api.get<Any>(`/agentplane/agent`).catch(() => ({ skills: [], connectors: [], plugins: [] })),
      get: () =>
        api.get<Any>(`/agentplane/agent`).catch(() => ({ skills: [], connectors: [], plugins: [] })),
      create: (params) =>
        api.post<Any>(`/agentplane/agent`, params),
      update: (_agentId, params) =>
        api.patch<Any>(`/agentplane/agent`, params),
      delete: () =>
        api.delete<Any>(`/agentplane/agent`),
      skills: {
        list: (_agentId) =>
          api.get<Any>('/agentplane/skills').then((r: Any) => r.skills ?? []).catch(() => []),
        get: (_agentId, folder) =>
          api.get<Any>(`/agentplane/skills/${encodeURIComponent(folder)}`).catch(() => null),
        create: (_agentId, skill) =>
          api.post<Any>('/agentplane/skills', skill),
        update: (_agentId, folder, params) =>
          api.patch<Any>(`/agentplane/skills/${encodeURIComponent(folder)}`, params),
        delete: (_agentId, folder) =>
          api.delete<Any>(`/agentplane/skills/${encodeURIComponent(folder)}`),
      },
      plugins: {
        list: (_agentId) =>
          api.get<Any>('/agentplane/plugins').then((r: Any) => r.plugins ?? []).catch(() => []),
        add: (_agentId, plugin) =>
          api.post<Any>('/agentplane/plugins', plugin),
        remove: (_agentId, marketplaceId, pluginName) =>
          api.delete<Any>(`/agentplane/plugins/${encodeURIComponent(marketplaceId)}/${encodeURIComponent(pluginName)}`),
      },
    },
    runs: {
      list: (params) => {
        const qs = new URLSearchParams();
        if (params?.limit) qs.set('limit', String(params.limit));
        if (params?.offset) qs.set('offset', String(params.offset));
        if (params?.status) qs.set('status', String(params.status));
        const suffix = qs.toString() ? `?${qs}` : '';
        return api.get<Any>(`/agentplane/runs${suffix}`).then((r: Any) => ({
          data: r.runs ?? r.data ?? [],
          limit: r.limit ?? 50,
          offset: r.offset ?? 0,
          has_more: r.has_more ?? false,
        })).catch(() => ({ data: [], limit: 50, offset: 0, has_more: false }));
      },
      get: (runId) =>
        api.get<Any>(`/agentplane/runs/${runId}`),
      cancel: (runId) =>
        api.post<Any>(`/agentplane/runs/${runId}/cancel`),
      transcript: (runId) =>
        api.get<Any>(`/agentplane/runs/${runId}`).then((r: Any) => r.transcript ?? []),
      transcriptArray: (runId) =>
        api.get<Any>(`/agentplane/runs/${runId}`).then((r: Any) => r.transcript ?? []),
    },
    sessions: {
      list: () =>
        api.get<Any>('/agentplane/sessions').catch(() => ({ data: [] })),
      get: (sessionId) =>
        api.get<Any>(`/agentplane/sessions/${sessionId}`),
      stop: (sessionId) =>
        api.post<Any>(`/agentplane/sessions/${sessionId}/stop`),
    },
    connectors: {
      list: (_agentId) =>
        api.get<Any>('/agentplane/connectors').then((r: Any) => r.connectors ?? r ?? []).catch(() => []),
      saveApiKey: (_agentId, params) =>
        api.post<Any>(`/agentplane/connectors/${encodeURIComponent(params.toolkit)}/api-key`, {
          api_key: params.api_key,
        }),
      initiateOauth: (_agentId, toolkit) =>
        api.post<Any>(`/agentplane/connectors/${encodeURIComponent(toolkit)}/oauth`),
      availableToolkits: () =>
        api.get<Any>('/agentplane/connectors/toolkits').catch(() => []),
      availableTools: (toolkit) =>
        api.get<Any>(`/agentplane/connectors/toolkits/${encodeURIComponent(toolkit)}/tools`).catch(() => []),
    },
    customConnectors: {
      listServers: () => Promise.resolve([]),
      createServer: () => Promise.resolve({} as Any),
      updateServer: () => Promise.resolve({} as Any),
      deleteServer: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      updateAllowedTools: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      initiateOauth: () => Promise.resolve({ redirectUrl: '' }),
    },
    models: {
      list: () => Promise.resolve([]),
    },
    dashboard: {
      stats: () => Promise.resolve({ agent_count: 0, total_runs: 0, active_runs: 0, total_spend: 0, session_count: 0 }),
      charts: () => Promise.resolve([]),
    },
    tenants: {
      getMe: () => Promise.resolve({}),
      updateMe: () => Promise.resolve({}),
    },
    keys: {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      revoke: () => Promise.resolve(),
    },
    composio: {
      toolkits: () =>
        api.get<Any>('/agentplane/connectors/toolkits').catch(() => []),
      tools: (toolkit) =>
        api.get<Any>(`/agentplane/connectors/toolkits/${encodeURIComponent(toolkit)}/tools`).catch(() => []),
    },
    pluginMarketplaces: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve({}),
      listPlugins: () => Promise.resolve([]),
      getPlugin: () => Promise.resolve({}),
      getPluginFiles: () => Promise.resolve({}),
      savePluginFiles: () => Promise.resolve({}),
      create: () => Promise.resolve({}),
      delete: () => Promise.resolve(),
      updateToken: () => Promise.resolve({}),
    },
  };
}

'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AgentPlaneProvider } from '@getcatalystiq/agent-plane-ui';
import { createProxyClient } from '@/lib/agentplane-proxy-client';

export function AgentPlaneSettingsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const client = useMemo(() => createProxyClient(), []);

  return (
    <AgentPlaneProvider
      client={client}
      onNavigate={(path) => router.push(path)}
      basePath="/settings"
    >
      {children}
    </AgentPlaneProvider>
  );
}

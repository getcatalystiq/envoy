'use client';
import { use } from 'react';
import { RunDetailPage } from '@getcatalystiq/agent-plane-ui';
import { AgentPlaneSettingsProvider } from '@/components/settings/AgentPlaneSettingsProvider';

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  return (
    <AgentPlaneSettingsProvider>
      <RunDetailPage runId={runId} />
    </AgentPlaneSettingsProvider>
  );
}

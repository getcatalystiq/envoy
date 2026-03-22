'use client';
import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Tags, AtSign, Sparkles, Plug, Activity, ArrowRightLeft, Puzzle } from 'lucide-react';
import { MenuButton } from '@/components/Layout';
import { TargetTypesList } from '@/components/settings/TargetTypesList';
import { SegmentsList } from '@/components/settings/SegmentsList';
import { EmailSettings } from '@/components/settings/EmailSettings';
import { GraduationRulesTab } from '@/components/settings/GraduationRulesTab';
import { AgentPlaneSettingsProvider } from '@/components/settings/AgentPlaneSettingsProvider';
import {
  RunListPage,
  AgentSkillManager,
  AgentConnectorsManager,
  AgentPluginManager,
} from '@getcatalystiq/agent-plane-ui';
import { api } from '@/lib/api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function useAgentData() {
  const [agent, setAgent] = useState<Any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Any>('/agentplane/skills')
      .then((data) => {
        // Fetch agent info to get toolkits and plugins
        return api.get<Any>('/agentplane/connectors').then((connData) => {
          setAgent({
            skills: data?.skills ?? [],
            connectors: connData?.connectors ?? [],
            toolkits: [],
            composioAllowedTools: [],
            plugins: [],
          });
        });
      })
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, []);

  return { agent, loading, reload: () => {
    api.get<Any>('/agentplane/skills').then((data) => {
      setAgent((prev: Any) => prev ? { ...prev, skills: data?.skills ?? [] } : prev);
    });
  }};
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = searchParams.get('tab') || 'email';
  const { agent, loading } = useAgentData();

  const handleTabChange = (value: string) => {
    router.push(`/settings?tab=${value}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <MenuButton />
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="text-muted-foreground">Configure your organization settings</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="email" className="flex items-center gap-2">
            <AtSign className="w-4 h-4" />
            Email
          </TabsTrigger>
          <TabsTrigger value="target-types" className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            Target Types
          </TabsTrigger>
          <TabsTrigger value="segments" className="flex items-center gap-2">
            <Tags className="w-4 h-4" />
            Segments
          </TabsTrigger>
          <TabsTrigger value="graduation-rules" className="flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4" />
            Graduation Rules
          </TabsTrigger>
          <TabsTrigger value="ai-skills" className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Skills
          </TabsTrigger>
          <TabsTrigger value="plugins" className="flex items-center gap-2">
            <Puzzle className="w-4 h-4" />
            Plugins
          </TabsTrigger>
          <TabsTrigger value="mcp-servers" className="flex items-center gap-2">
            <Plug className="w-4 h-4" />
            Connectors
          </TabsTrigger>
          <TabsTrigger value="ai-activity" className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            AI Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="email" className="mt-6">
          <EmailSettings />
        </TabsContent>

        <TabsContent value="target-types" className="mt-6">
          <TargetTypesList />
        </TabsContent>

        <TabsContent value="segments" className="mt-6">
          <SegmentsList />
        </TabsContent>

        <TabsContent value="graduation-rules" className="mt-6">
          <GraduationRulesTab />
        </TabsContent>

        <AgentPlaneSettingsProvider>
          <TabsContent value="ai-skills" className="mt-6">
            {!loading && agent && (
              <AgentSkillManager
                agentId=""
                initialSkills={agent.skills}
              />
            )}
          </TabsContent>

          <TabsContent value="plugins" className="mt-6">
            {!loading && agent && (
              <AgentPluginManager
                agentId=""
                initialPlugins={agent.plugins}
              />
            )}
          </TabsContent>

          <TabsContent value="mcp-servers" className="mt-6">
            {!loading && agent && (
              <AgentConnectorsManager
                agentId=""
                toolkits={agent.toolkits}
                composioAllowedTools={agent.composioAllowedTools}
              />
            )}
          </TabsContent>

          <TabsContent value="ai-activity" className="mt-6">
            <RunListPage />
          </TabsContent>
        </AgentPlaneSettingsProvider>
      </Tabs>
    </div>
  );
}

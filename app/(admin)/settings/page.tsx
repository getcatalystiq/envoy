'use client';
import { useState, useEffect, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
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

class TabErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Tab component error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="p-6 text-center text-muted-foreground">
          <p>Failed to load this section. The AI service may be temporarily unavailable.</p>
          <button className="mt-3 text-sm underline" onClick={() => this.setState({ hasError: false })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

 
type Any = any;

function useAgentData() {
  const [agent, setAgent] = useState<Any>({
    skills: [],
    connectors: [],
    toolkits: [],
    composioAllowedTools: [],
    plugins: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Any>('/agentplane/agent')
      .catch(() => ({ skills: [], connectors: [], plugins: [], composio_toolkits: [], composio_allowed_tools: [] }))
      .then((agentData) => {
        setAgent({
          skills: agentData?.skills ?? [],
          connectors: agentData?.connectors ?? [],
          toolkits: agentData?.composio_toolkits ?? [],
          composioAllowedTools: agentData?.composio_allowed_tools ?? [],
          plugins: agentData?.plugins ?? [],
        });
      })
      .finally(() => setLoading(false));
  }, []);

  return { agent, loading, reload: () => {
    api.get<Any>('/agentplane/skills').catch(() => ({ skills: [] })).then((data) => {
      setAgent((prev: Any) => ({ ...prev, skills: data?.skills ?? [] }));
    });
  }};
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get('tab') || 'email';
  const [activeTab, setActiveTab] = useState(initialTab);
  const { agent, loading } = useAgentData();

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    window.history.replaceState(null, '', `/settings?tab=${value}`);
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
            <TabErrorBoundary>
              {!loading && (
                <AgentSkillManager
                  agentId=""
                  initialSkills={agent.skills}
                />
              )}
            </TabErrorBoundary>
          </TabsContent>

          <TabsContent value="plugins" className="mt-6">
            <TabErrorBoundary>
              {!loading && (
                <AgentPluginManager
                  agentId=""
                  initialPlugins={agent.plugins}
                />
              )}
            </TabErrorBoundary>
          </TabsContent>

          <TabsContent value="mcp-servers" className="mt-6">
            <TabErrorBoundary>
              {!loading && (
                <AgentConnectorsManager
                  agentId=""
                  toolkits={agent.toolkits}
                  composioAllowedTools={agent.composioAllowedTools}
                />
              )}
            </TabErrorBoundary>
          </TabsContent>

          <TabsContent value="ai-activity" className="mt-6">
            <RunListPage />
          </TabsContent>
        </AgentPlaneSettingsProvider>
      </Tabs>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Tags, AtSign, Sparkles, Activity, ArrowRightLeft } from 'lucide-react';
import { MenuButton } from '@/components/Layout';
import { TargetTypesList } from '@/components/settings/TargetTypesList';
import { SegmentsList } from '@/components/settings/SegmentsList';
import { EmailSettings } from '@/components/settings/EmailSettings';
import { GraduationRulesTab } from '@/components/settings/GraduationRulesTab';
import { AgentActivityList } from '@/components/settings/AgentActivityList';
import { AgentInstructions } from '@/components/settings/AgentInstructions';
import { AgentConfig } from '@/components/settings/AgentConfig';

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get('tab') || 'email';
  const [activeTab, setActiveTab] = useState(initialTab);

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
          <TabsTrigger value="instructions" className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Agent
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

        <TabsContent value="instructions" className="mt-6 space-y-8">
          <AgentConfig />
          <div className="border-t pt-6">
            <h2 className="text-lg font-medium mb-1">Instructions</h2>
            <AgentInstructions />
          </div>
        </TabsContent>

        <TabsContent value="ai-activity" className="mt-6">
          <AgentActivityList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

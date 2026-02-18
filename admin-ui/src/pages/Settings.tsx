import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Tags, AtSign, Sparkles, Plug, Activity, ArrowRightLeft } from 'lucide-react';
import { MenuButton } from '@/components/Layout';
import { TargetTypesList } from './TargetTypes';
import { SegmentsList } from './Segments';
import { EmailSettings } from './EmailSettings';
import { SkillsTab } from './settings/SkillsTab';
import { ConnectorsTab } from './settings/ConnectorsTab';
import { ActivityTab } from './settings/ActivityTab';
import { GraduationRulesTab } from './settings/GraduationRulesTab';

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'email';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <MenuButton />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-600">Configure your organization settings</p>
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

        <TabsContent value="ai-skills" className="mt-6">
          <SkillsTab />
        </TabsContent>

        <TabsContent value="mcp-servers" className="mt-6">
          <ConnectorsTab />
        </TabsContent>

        <TabsContent value="ai-activity" className="mt-6">
          <ActivityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

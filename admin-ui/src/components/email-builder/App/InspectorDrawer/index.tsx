import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { setSidebarTab, useInspectorDrawerOpen, useSelectedSidebarTab } from '../../documents/editor/EditorContext';

import ConfigurationPanel from './ConfigurationPanel';
import StylesPanel from './StylesPanel';

export const INSPECTOR_DRAWER_WIDTH = 320;

export default function InspectorDrawer() {
  const selectedSidebarTab = useSelectedSidebarTab();
  const inspectorDrawerOpen = useInspectorDrawerOpen();

  return (
    <div
      className={cn(
        'fixed top-[89px] right-[23px] h-[calc(100%-89px)] bg-background border-l border-border transition-all duration-200',
        inspectorDrawerOpen ? 'w-[320px]' : 'w-0 overflow-hidden'
      )}
    >
      <div className="w-[320px] h-full flex flex-col">
        <Tabs
          value={selectedSidebarTab}
          onValueChange={(value) => setSidebarTab(value as 'block-configuration' | 'styles')}
          className="flex flex-col h-full"
        >
          <TabsList className="w-full rounded-none border-b border-border bg-transparent h-12 p-0">
            <TabsTrigger
              value="styles"
              className="flex-1 rounded-none data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary h-full"
            >
              Styles
            </TabsTrigger>
            <TabsTrigger
              value="block-configuration"
              className="flex-1 rounded-none data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary h-full"
            >
              Inspect
            </TabsTrigger>
          </TabsList>
          <TabsContent value="styles" className="flex-1 overflow-auto mt-0">
            <StylesPanel />
          </TabsContent>
          <TabsContent value="block-configuration" className="flex-1 overflow-auto mt-0">
            <ConfigurationPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

import { ReactNode, useEffect } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { PanelRightClose, PanelRight } from 'lucide-react';

import EditorBlock from './documents/editor/EditorBlock';
import { Reader } from './Reader';
import MainTabsGroup from './App/TemplatePanel/MainTabsGroup';
import ConfigurationPanel from './App/InspectorDrawer/ConfigurationPanel';
import StylesPanel from './App/InspectorDrawer/StylesPanel';
import {
  useInspectorDrawerOpen,
  useDocument,
  useSelectedMainTab,
  useSelectedScreenSize,
  useSelectedSidebarTab,
  setSelectedScreenSize,
  setSidebarTab,
  toggleInspectorDrawerOpen,
  setReadOnly,
} from './documents/editor/EditorContext';

const INSPECTOR_WIDTH = 320;

type SidebarTab = 'block-configuration' | 'styles';

interface EmailEditorCoreProps {
  /** Extra toolbar actions to render on the right side */
  toolbarActions?: ReactNode;
  /** Additional sidebar tabs beyond the default Styles and Inspect */
  extraSidebarTabs?: Array<{
    id: string;
    label: string;
    content: ReactNode;
  }>;
  /** Height calculation for the editor area. Default: 100% */
  editorHeight?: string;
  /** Whether to show the HTML and JSON tabs */
  showCodeTabs?: boolean;
  /** Class name for the outer container */
  className?: string;
  /** Whether the editor is in read-only mode */
  readOnly?: boolean;
}

export function EmailEditorCore({
  toolbarActions,
  extraSidebarTabs = [],
  editorHeight = '100%',
  showCodeTabs = false,
  className,
  readOnly: readOnlyProp = false,
}: EmailEditorCoreProps) {
  const inspectorDrawerOpen = useInspectorDrawerOpen();
  const document = useDocument();
  const selectedMainTab = useSelectedMainTab();
  const selectedScreenSize = useSelectedScreenSize();
  const selectedSidebarTab = useSelectedSidebarTab();

  // Sync readOnly prop with context
  useEffect(() => {
    setReadOnly(readOnlyProp);
  }, [readOnlyProp]);

  const mobileStyles = selectedScreenSize === 'mobile'
    ? 'mx-auto my-8 w-[370px] h-[800px] shadow-[rgba(33,36,67,0.04)_0px_10px_20px,rgba(33,36,67,0.04)_0px_2px_6px,rgba(33,36,67,0.04)_0px_0px_1px]'
    : 'h-full';

  const renderEditorContent = () => {
    switch (selectedMainTab) {
      case 'editor':
        return (
          <div className={mobileStyles}>
            <EditorBlock id="root" />
          </div>
        );
      case 'preview':
        return (
          <div className={mobileStyles}>
            <Reader document={document} rootBlockId="root" />
          </div>
        );
      default:
        return (
          <div className={mobileStyles}>
            <EditorBlock id="root" />
          </div>
        );
    }
  };

  const renderInspectorContent = () => {
    // Check if it's one of the extra tabs
    const extraTab = extraSidebarTabs.find(tab => tab.id === selectedSidebarTab);
    if (extraTab) {
      return extraTab.content;
    }

    // Default tabs
    switch (selectedSidebarTab) {
      case 'block-configuration':
        return <ConfigurationPanel showPersonalization />;
      case 'styles':
        return <StylesPanel />;
      default:
        return <ConfigurationPanel showPersonalization />;
    }
  };

  const allTabs: Array<{ id: string; label: string }> = [
    { id: 'block-configuration', label: 'Inspect' },
    { id: 'styles', label: 'Styles' },
    ...extraSidebarTabs.map(tab => ({ id: tab.id, label: tab.label })),
  ];

  return (
    <div className={cn('flex h-full', className)}>
      {/* Editor Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Editor Toolbar */}
        <TooltipProvider>
          <div className="h-[49px] border-b border-border bg-white px-1 flex flex-row justify-between items-center shrink-0">
            <div className="px-2 flex flex-row gap-4 w-full justify-between items-center">
              <div className="flex flex-row gap-4">
                <MainTabsGroup showCodeTabs={showCodeTabs} />
              </div>
              <div className="flex flex-row gap-4 items-center">
                {toolbarActions}
                <ToggleGroup
                  type="single"
                  value={selectedScreenSize}
                  onValueChange={(value) => {
                    if (value === 'mobile' || value === 'desktop') {
                      setSelectedScreenSize(value);
                    }
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ToggleGroupItem value="desktop" size="sm">
                        <Monitor className="h-4 w-4" />
                      </ToggleGroupItem>
                    </TooltipTrigger>
                    <TooltipContent>Desktop view</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ToggleGroupItem value="mobile" size="sm">
                        <Smartphone className="h-4 w-4" />
                      </ToggleGroupItem>
                    </TooltipTrigger>
                    <TooltipContent>Mobile view</TooltipContent>
                  </Tooltip>
                </ToggleGroup>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleInspectorDrawerOpen()}
                  className="h-8 w-8 p-0"
                >
                  {inspectorDrawerOpen ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </TooltipProvider>

        {/* Email Editor Area */}
        <div
          className="flex-1 overflow-auto bg-[#f8f9fa] min-w-[370px]"
          style={{ height: editorHeight }}
        >
          {renderEditorContent()}
        </div>
      </div>

      {/* Inspector Panel */}
      {inspectorDrawerOpen && (
        <div
          className="border-l bg-white flex flex-col shrink-0"
          style={{ width: INSPECTOR_WIDTH, minWidth: INSPECTOR_WIDTH }}
        >
          <Tabs
            value={selectedSidebarTab}
            onValueChange={(value) => setSidebarTab(value as SidebarTab)}
            className="border-b border-border"
          >
            <TabsList className="h-[49px] w-full justify-start rounded-none bg-transparent p-0">
              {allTabs.map(tab => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent h-full"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex-1 overflow-auto">
            {renderInspectorContent()}
          </div>
        </div>
      )}
    </div>
  );
}

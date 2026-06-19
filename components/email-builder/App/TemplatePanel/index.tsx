'use client';
import { useMemo } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { renderToStaticMarkup } from '../../renderers';

import EditorBlock from '../../documents/editor/EditorBlock';
import {
  setSelectedScreenSize,
  useDocument,
  useSelectedMainTab,
  useSelectedScreenSize,
} from '../../documents/editor/EditorContext';
import ToggleInspectorPanelButton from '../InspectorDrawer/ToggleInspectorPanelButton';

import DownloadJson from './DownloadJson';
import HtmlPanel from './HtmlPanel';
import ImportJson from './ImportJson';
import JsonPanel from './JsonPanel';
import MainTabsGroup from './MainTabsGroup';
import ShareButton from './ShareButton';

export default function TemplatePanel() {
  const document = useDocument();
  const selectedMainTab = useSelectedMainTab();
  const selectedScreenSize = useSelectedScreenSize();

  // Render the preview as a static HTML document and show it inside a sandboxed
  // iframe. Email content holds unrendered template tokens (e.g.
  // `{{unsubscribe_link}}`) emitted as relative <a href> values; rendered into
  // the admin DOM they resolve against the current route and navigate the app
  // (and previously 500'd the design-template route). The sandbox (no
  // allow-scripts / allow-top-navigation / allow-forms) keeps any click or form
  // contained to the frame and strips script execution from preview content.
  const previewHtml = useMemo(
    () => renderToStaticMarkup(document, { rootBlockId: 'root' }),
    [document]
  );

  const mobileStyles = selectedScreenSize === 'mobile'
    ? 'mx-auto my-8 w-[370px] h-[800px] shadow-[rgba(33,36,67,0.04)_0px_10px_20px,rgba(33,36,67,0.04)_0px_2px_6px,rgba(33,36,67,0.04)_0px_0px_1px]'
    : 'h-full';

  const renderMainPanel = () => {
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
            <iframe
              srcDoc={previewHtml}
              sandbox="allow-same-origin"
              className="w-full h-full min-h-[600px] border-0 bg-white"
              title="Email preview"
            />
          </div>
        );
      case 'html':
        return <HtmlPanel />;
      case 'json':
        return <JsonPanel />;
    }
  };

  return (
    <TooltipProvider>
      <div className="h-[49px] border-b border-border bg-background sticky top-0 z-10 px-1 flex flex-row justify-between items-center">
        <div className="px-2 flex flex-row gap-4 w-full justify-between items-center">
          <div className="flex flex-row gap-4">
            <MainTabsGroup />
          </div>
          <div className="flex flex-row gap-4 items-center">
            <DownloadJson />
            <ImportJson />
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
            <ShareButton />
            <ToggleInspectorPanelButton />
          </div>
        </div>
      </div>
      <div className="h-[calc(100vh-102px)] overflow-auto min-w-[370px]">{renderMainPanel()}</div>
    </TooltipProvider>
  );
}

'use client';
import { Code, Eye, FileJson, Pencil } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { setSelectedMainTab, useSelectedMainTab } from '../../documents/editor/EditorContext';

interface MainTabsGroupProps {
  /** Whether to show HTML and JSON tabs. Default: true */
  showCodeTabs?: boolean;
}

export default function MainTabsGroup({ showCodeTabs = true }: MainTabsGroupProps) {
  const selectedMainTab = useSelectedMainTab();

  return (
    <ToggleGroup
      type="single"
      value={selectedMainTab}
      onValueChange={(value) => {
        if (value === 'json' || value === 'preview' || value === 'editor' || value === 'html') {
          setSelectedMainTab(value);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="editor" size="sm">
            <Pencil className="h-4 w-4" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="preview" size="sm">
            <Eye className="h-4 w-4" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Preview</TooltipContent>
      </Tooltip>
      {showCodeTabs && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem value="html" size="sm">
                <Code className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>HTML output</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem value="json" size="sm">
                <FileJson className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>JSON output</TooltipContent>
          </Tooltip>
        </>
      )}
    </ToggleGroup>
  );
}

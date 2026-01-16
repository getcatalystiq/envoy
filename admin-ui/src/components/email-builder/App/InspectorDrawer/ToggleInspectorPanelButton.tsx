import { ChevronRight, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { toggleInspectorDrawerOpen, useInspectorDrawerOpen } from '../../documents/editor/EditorContext';

export default function ToggleInspectorPanelButton() {
  const inspectorDrawerOpen = useInspectorDrawerOpen();

  const handleClick = () => {
    toggleInspectorDrawerOpen();
  };

  return (
    <Button variant="ghost" size="icon" onClick={handleClick}>
      {inspectorDrawerOpen ? (
        <ChevronRight className="h-4 w-4" />
      ) : (
        <Settings2 className="h-4 w-4" />
      )}
    </Button>
  );
}

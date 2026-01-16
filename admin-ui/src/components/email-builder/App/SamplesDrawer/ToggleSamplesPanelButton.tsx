import { ChevronLeft, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { toggleSamplesDrawerOpen, useSamplesDrawerOpen } from '../../documents/editor/EditorContext';

export default function ToggleSamplesPanelButton() {
  const samplesDrawerOpen = useSamplesDrawerOpen();

  return (
    <Button variant="ghost" size="icon" onClick={toggleSamplesDrawerOpen}>
      {samplesDrawerOpen ? (
        <ChevronLeft className="h-4 w-4" />
      ) : (
        <Menu className="h-4 w-4" />
      )}
    </Button>
  );
}

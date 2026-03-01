'use client';
import { Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useDocument } from '../../documents/editor/EditorContext';

export default function ShareButton() {
  const document = useDocument();

  const onClick = async () => {
    const c = encodeURIComponent(JSON.stringify(document));
    location.hash = `#code/${btoa(c)}`;
    toast.info('The URL was updated. Copy it to share your current template.');
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onClick}>
          <Share2 className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Share current template</TooltipContent>
    </Tooltip>
  );
}

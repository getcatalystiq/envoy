'use client';
import { useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import ImportJsonDialog from './ImportJsonDialog';

export default function ImportJson() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)}>
            <Upload className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Import JSON</TooltipContent>
      </Tooltip>
      {open && <ImportJsonDialog onClose={() => setOpen(false)} />}
    </>
  );
}

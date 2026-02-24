'use client';
import { Button } from '@/components/ui/button';

import { resetDocument } from '../../documents/editor/EditorContext';
import getConfiguration from '../../getConfiguration';

export default function SidebarButton({ href, children }: { href: string; children: React.ReactNode }) {
  const handleClick = () => {
    resetDocument(getConfiguration(href));
  };
  return (
    <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
      <a href={href} onClick={handleClick}>
        {children}
      </a>
    </Button>
  );
}

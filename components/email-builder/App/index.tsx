'use client';
import { cn } from '@/lib/utils';

import { useInspectorDrawerOpen } from '../documents/editor/EditorContext';

import InspectorDrawer from './InspectorDrawer';
import TemplatePanel from './TemplatePanel';

export default function App() {
  const inspectorDrawerOpen = useInspectorDrawerOpen();

  return (
    <>
      <InspectorDrawer />
      <div
        className={cn(
          'transition-all duration-200',
          inspectorDrawerOpen ? 'mr-[320px]' : 'mr-0'
        )}
      >
        <TemplatePanel />
      </div>
    </>
  );
}

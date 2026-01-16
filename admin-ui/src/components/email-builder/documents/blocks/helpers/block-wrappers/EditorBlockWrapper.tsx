import { useState } from 'react';
import { cn } from '@/lib/utils';

import { useCurrentBlockId } from '../../../editor/EditorBlock';
import { setSelectedBlockId, useDocument, useSelectedBlockId } from '../../../editor/EditorContext';

import TuneMenu from './TuneMenu';

type TEditorBlockWrapperProps = {
  children: JSX.Element;
};

export default function EditorBlockWrapper({ children }: TEditorBlockWrapperProps) {
  const selectedBlockId = useSelectedBlockId();
  const document = useDocument();
  const [mouseInside, setMouseInside] = useState(false);
  const blockId = useCurrentBlockId();

  const isSelected = selectedBlockId === blockId;
  const block = document[blockId];
  const hasPersonalization = block?.data?.personalization?.enabled;

  return (
    <div
      className={cn(
        'relative max-w-full -outline-offset-1',
        isSelected && !hasPersonalization && 'outline outline-2 outline-[rgba(0,121,204,1)]',
        !isSelected && mouseInside && !hasPersonalization && 'outline outline-2 outline-[rgba(0,121,204,0.3)]',
        hasPersonalization && 'ai-shimmer-border'
      )}
      onMouseEnter={(ev) => {
        setMouseInside(true);
        ev.stopPropagation();
      }}
      onMouseLeave={() => {
        setMouseInside(false);
      }}
      onClick={(ev) => {
        setSelectedBlockId(blockId);
        ev.stopPropagation();
        ev.preventDefault();
      }}
    >
      {isSelected && <TuneMenu blockId={blockId} />}
      {children}
    </div>
  );
}

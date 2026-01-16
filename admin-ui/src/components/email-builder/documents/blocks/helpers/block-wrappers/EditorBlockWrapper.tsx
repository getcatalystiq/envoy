import { useState } from 'react';
import { cn } from '@/lib/utils';

import { useCurrentBlockId } from '../../../editor/EditorBlock';
import { setSelectedBlockId, useDocument, useSelectedBlockId } from '../../../editor/EditorContext';

import TuneMenu from './TuneMenu';

type TEditorBlockWrapperProps = {
  children: JSX.Element;
};

const SPARKLE_POSITIONS = [
  { top: '-6px', left: '10%', delay: '0s' },
  { top: '-6px', right: '20%', delay: '0.4s' },
  { top: '30%', right: '-6px', delay: '0.8s' },
  { bottom: '30%', right: '-6px', delay: '1.2s' },
  { bottom: '-6px', right: '15%', delay: '1.6s' },
  { bottom: '-6px', left: '25%', delay: '2s' },
  { top: '40%', left: '-6px', delay: '0.6s' },
  { top: '60%', left: '-6px', delay: '1.4s' },
];

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
      {hasPersonalization && SPARKLE_POSITIONS.map((pos, i) => (
        <span
          key={i}
          className="ai-sparkle"
          style={{
            ...pos,
            animationDelay: pos.delay,
          }}
        >
          ✦
        </span>
      ))}
      {isSelected && <TuneMenu blockId={blockId} />}
      {children}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

import { useCurrentBlockId } from '../../../editor/EditorBlock';
import { setSelectedBlockId, useDocument, useSelectedBlockId } from '../../../editor/EditorContext';

import TuneMenu from './TuneMenu';

type TEditorBlockWrapperProps = {
  children: JSX.Element;
};

type SparklePosition = {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
};

const generateRandomPosition = (): SparklePosition => {
  const side = Math.floor(Math.random() * 4);
  const percent = Math.floor(Math.random() * 80) + 10;

  switch (side) {
    case 0: return { top: '-6px', left: `${percent}%` };
    case 1: return { bottom: '-6px', left: `${percent}%` };
    case 2: return { left: '-6px', top: `${percent}%` };
    case 3: return { right: '-6px', top: `${percent}%` };
    default: return { top: '-6px', left: '50%' };
  }
};

const SPARKLE_COUNT = 6;

export default function EditorBlockWrapper({ children }: TEditorBlockWrapperProps) {
  const selectedBlockId = useSelectedBlockId();
  const document = useDocument();
  const [mouseInside, setMouseInside] = useState(false);
  const blockId = useCurrentBlockId();

  const isSelected = selectedBlockId === blockId;
  const block = document[blockId];
  const hasPersonalization = block?.data?.personalization?.enabled;

  const generateSparkles = useCallback(() =>
    Array.from({ length: SPARKLE_COUNT }, () => ({
      id: Math.random(),
      position: generateRandomPosition(),
    })), []);

  const [sparkles, setSparkles] = useState(generateSparkles);

  useEffect(() => {
    if (!hasPersonalization) return;

    const interval = setInterval(() => {
      setSparkles(generateSparkles());
    }, 3500);

    return () => clearInterval(interval);
  }, [hasPersonalization, generateSparkles]);

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
      {hasPersonalization && sparkles.map((sparkle) => (
        <span
          key={sparkle.id}
          className="ai-sparkle"
          style={sparkle.position}
        >
          ✦
        </span>
      ))}
      {isSelected && <TuneMenu blockId={blockId} />}
      {children}
    </div>
  );
}

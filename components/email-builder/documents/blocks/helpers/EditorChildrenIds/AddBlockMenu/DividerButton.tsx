'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  buttonElement: HTMLElement | null;
  onClick: () => void;
};

export default function DividerButton({ buttonElement, onClick }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function listener({ clientX, clientY }: MouseEvent) {
      if (!buttonElement) {
        return;
      }
      const rect = buttonElement.getBoundingClientRect();
      const rectY = rect.y;
      const bottomX = rect.x;
      const topX = bottomX + rect.width;

      if (Math.abs(clientY - rectY) < 20) {
        if (bottomX < clientX && clientX < topX) {
          setVisible(true);
          return;
        }
      }
      setVisible(false);
    }
    window.addEventListener('mousemove', listener);
    return () => {
      window.removeEventListener('mousemove', listener);
    };
  }, [buttonElement, setVisible]);

  return (
    <button
      className={cn(
        'absolute top-[-12px] left-1/2 -translate-x-2.5 z-50 p-0.5 rounded-full bg-primary text-primary-foreground transition-opacity duration-200',
        'hover:bg-primary focus:bg-primary',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      )}
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}

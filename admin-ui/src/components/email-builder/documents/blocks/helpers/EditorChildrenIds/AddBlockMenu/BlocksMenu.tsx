import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { TEditorBlock } from '../../../../editor/core';

import BlockButton from './BlockButton';
import { BUTTONS } from './buttons';

type BlocksMenuProps = {
  anchorEl: HTMLElement | null;
  setAnchorEl: (v: HTMLElement | null) => void;
  onSelect: (block: TEditorBlock) => void;
};

export default function BlocksMenu({ anchorEl, setAnchorEl, onSelect }: BlocksMenuProps) {
  const onClose = () => {
    setAnchorEl(null);
  };

  const onClick = (block: TEditorBlock) => {
    onSelect(block);
    setAnchorEl(null);
  };

  if (anchorEl === null) {
    return null;
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverTrigger asChild>
        <span
          style={{
            position: 'fixed',
            left: anchorEl.getBoundingClientRect().left + anchorEl.getBoundingClientRect().width / 2,
            top: anchorEl.getBoundingClientRect().bottom,
          }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="center">
        <div className="grid grid-cols-4 gap-1">
          {BUTTONS.map((k, i) => (
            <BlockButton key={i} label={k.label} icon={k.icon} onClick={() => onClick(k.block())} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

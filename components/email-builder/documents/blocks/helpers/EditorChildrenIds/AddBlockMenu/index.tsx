'use client';
import { useState } from 'react';

import { TEditorBlock } from '../../../../editor/core';
import { useReadOnly } from '../../../../editor/EditorContext';

import BlocksMenu from './BlocksMenu';
import DividerButton from './DividerButton';
import PlaceholderButton from './PlaceholderButton';

type Props = {
  placeholder?: boolean;
  onSelect: (block: TEditorBlock) => void;
};
export default function AddBlockButton({ onSelect, placeholder }: Props) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [buttonElement, setButtonElement] = useState<HTMLElement | null>(null);
  const readOnly = useReadOnly();

  // Hide add block buttons in read-only mode
  if (readOnly) {
    return null;
  }

  const handleButtonClick = () => {
    setMenuAnchorEl(buttonElement);
  };

  const renderButton = () => {
    if (placeholder) {
      return <PlaceholderButton onClick={handleButtonClick} />;
    } else {
      return <DividerButton buttonElement={buttonElement} onClick={handleButtonClick} />;
    }
  };

  return (
    <>
      <div ref={setButtonElement} style={{ position: 'relative' }}>
        {renderButton()}
      </div>
      <BlocksMenu anchorEl={menuAnchorEl} setAnchorEl={setMenuAnchorEl} onSelect={onSelect} />
    </>
  );
}

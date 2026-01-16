import { useState, useRef, useEffect, KeyboardEvent } from 'react';

import { Heading as BaseHeading, HeadingProps, HeadingPropsDefaults } from '../../../blocks/Heading';
import { getFontFamily, getPadding } from '../../../blocks/shared';
import { useCurrentBlockId } from '../../editor/EditorBlock';
import { setDocument, useDocument } from '../../editor/EditorContext';

function getFontSize(level: 'h1' | 'h2' | 'h3'): number {
  switch (level) {
    case 'h1':
      return 32;
    case 'h2':
      return 24;
    case 'h3':
      return 20;
  }
}

export default function HeadingEditor({ style, props }: HeadingProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const currentBlockId = useCurrentBlockId();
  const document = useDocument();

  const text = props?.text ?? HeadingPropsDefaults.text;
  const level = props?.level ?? HeadingPropsDefaults.level;

  // Focus the input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditValue(text);
    setIsEditing(true);
  };

  const handleBlur = () => {
    // Save changes to document
    if (editValue !== text) {
      setDocument({
        [currentBlockId]: {
          type: 'Heading',
          data: {
            ...document[currentBlockId].data,
            props: {
              ...props,
              text: editValue,
            },
          },
        },
      });
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Escape cancels editing without saving
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditing(false);
    }
    // Enter saves and exits
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    }
  };

  // When editing, show an input with the same styling
  if (isEditing) {
    const editorStyle: React.CSSProperties = {
      color: style?.color ?? undefined,
      backgroundColor: style?.backgroundColor ?? 'transparent',
      fontWeight: style?.fontWeight ?? 'bold',
      textAlign: style?.textAlign ?? undefined,
      margin: 0,
      fontFamily: getFontFamily(style?.fontFamily),
      fontSize: getFontSize(level),
      padding: getPadding(style?.padding),
      // Input-specific styles
      width: '100%',
      border: 'none',
      outline: 'none',
      lineHeight: 'inherit',
      display: 'block',
    };

    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={editorStyle}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  // When not editing, render the normal heading with double-click handler
  return (
    <div onDoubleClick={handleDoubleClick} style={{ cursor: 'text' }}>
      <BaseHeading style={style} props={props} />
    </div>
  );
}

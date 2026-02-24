'use client';
import { useState, useRef, useEffect, KeyboardEvent } from 'react';

import { Text as BaseText, TextProps, TextPropsDefaults } from '../../../blocks/Text';
import { getFontFamily, getPadding } from '../../../blocks/shared';
import { useCurrentBlockId } from '../../editor/EditorBlock';
import { setDocument, useDocument } from '../../editor/EditorContext';

export default function TextEditor({ style, props }: TextProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const currentBlockId = useCurrentBlockId();
  const document = useDocument();

  const text = props?.text ?? TextPropsDefaults.text;

  // Focus the textarea when entering edit mode
  useEffect(() => {
    if (isEditing && editorRef.current) {
      editorRef.current.focus();
      // Move cursor to end
      editorRef.current.selectionStart = editorRef.current.value.length;
      editorRef.current.selectionEnd = editorRef.current.value.length;
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
          type: 'Text',
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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape cancels editing without saving
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditing(false);
    }
    // Cmd/Ctrl + Enter saves and exits
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      editorRef.current?.blur();
    }
  };

  // When editing, show a textarea with the same styling
  if (isEditing) {
    const editorStyle: React.CSSProperties = {
      color: style?.color ?? undefined,
      backgroundColor: style?.backgroundColor ?? 'transparent',
      fontSize: style?.fontSize ?? undefined,
      fontFamily: getFontFamily(style?.fontFamily),
      fontWeight: style?.fontWeight ?? undefined,
      textAlign: style?.textAlign ?? undefined,
      padding: getPadding(style?.padding),
      // Textarea-specific styles
      width: '100%',
      minHeight: '1.5em',
      border: 'none',
      outline: 'none',
      resize: 'none',
      overflow: 'hidden',
      lineHeight: 'inherit',
      display: 'block',
    };

    return (
      <textarea
        ref={editorRef}
        value={editValue}
        onChange={(e) => {
          setEditValue(e.target.value);
          // Auto-resize textarea
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={editorStyle}
        rows={1}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  // When not editing, render the normal text with double-click handler
  return (
    <div onDoubleClick={handleDoubleClick} style={{ cursor: 'text' }}>
      <BaseText style={style} props={props} />
    </div>
  );
}

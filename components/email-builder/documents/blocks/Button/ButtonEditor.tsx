'use client';
import { useState, useRef, useEffect, KeyboardEvent } from 'react';

import { Button as BaseButton, ButtonProps, ButtonPropsDefaults } from '../../../blocks/Button';
import { getFontFamily, getPadding } from '../../../blocks/shared';
import { useCurrentBlockId } from '../../editor/EditorBlock';
import { setDocument, useDocument } from '../../editor/EditorContext';

function getRoundedCorners(props: ButtonProps['props']): number | undefined {
  const buttonStyle = props?.buttonStyle ?? ButtonPropsDefaults.buttonStyle;
  switch (buttonStyle) {
    case 'rectangle':
      return undefined;
    case 'pill':
      return 64;
    case 'rounded':
    default:
      return 4;
  }
}

function getButtonSizePadding(props: ButtonProps['props']): [number, number] {
  const size = props?.size ?? ButtonPropsDefaults.size;
  switch (size) {
    case 'x-small':
      return [4, 8];
    case 'small':
      return [8, 12];
    case 'large':
      return [16, 32];
    case 'medium':
    default:
      return [12, 20];
  }
}

export default function ButtonEditor({ style, props }: ButtonProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const currentBlockId = useCurrentBlockId();
  const document = useDocument();

  const text = props?.text ?? ButtonPropsDefaults.text;
  const fullWidth = props?.fullWidth ?? ButtonPropsDefaults.fullWidth;
  const buttonTextColor = props?.buttonTextColor ?? ButtonPropsDefaults.buttonTextColor;
  const buttonBackgroundColor = props?.buttonBackgroundColor ?? ButtonPropsDefaults.buttonBackgroundColor;

  const padding = getButtonSizePadding(props);

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
          type: 'Button',
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

  // When editing, show an input styled like the button
  if (isEditing) {
    const wrapperStyle: React.CSSProperties = {
      backgroundColor: style?.backgroundColor ?? undefined,
      textAlign: style?.textAlign ?? undefined,
      padding: getPadding(style?.padding),
    };

    const inputStyle: React.CSSProperties = {
      color: buttonTextColor,
      fontSize: style?.fontSize ?? 16,
      fontFamily: getFontFamily(style?.fontFamily),
      fontWeight: style?.fontWeight ?? 'bold',
      backgroundColor: buttonBackgroundColor,
      borderRadius: getRoundedCorners(props),
      display: fullWidth ? 'block' : 'inline-block',
      padding: `${padding[0]}px ${padding[1]}px`,
      textDecoration: 'none',
      // Input-specific styles
      border: 'none',
      outline: 'none',
      textAlign: 'center',
      width: fullWidth ? '100%' : 'auto',
      minWidth: '60px',
    };

    return (
      <div style={wrapperStyle}>
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={inputStyle}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  // When not editing, render the normal button with double-click handler
  return (
    <div onDoubleClick={handleDoubleClick} style={{ cursor: 'text' }}>
      <BaseButton style={style} props={props} />
    </div>
  );
}

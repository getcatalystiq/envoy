'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';

import { Html as BaseHtml, HtmlProps } from '../../../blocks/Html';
import { getFontFamily, getPadding } from '../../../blocks/shared';
import { useCurrentBlockId } from '../../editor/EditorBlock';
import { setDocument, useDocument } from '../../editor/EditorContext';
import { useReadOnly } from '../../editor/EditorContext';
import HtmlToolbar from './HtmlToolbar';

export default function HtmlEditor({ style, props }: HtmlProps) {
  const [isEditing, setIsEditing] = useState(false);
  const currentBlockId = useCurrentBlockId();
  const document = useDocument();
  const readOnly = useReadOnly();
  const isToolbarInteraction = useRef(false);

  const contents = props?.contents ?? '';

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'underline',
        },
      }),
      Placeholder.configure({
        placeholder: 'Start typing...',
      }),
      TextStyle,
      Color,
    ],
    content: contents,
    editable: true,
    onUpdate: ({ editor }) => {
      // Save changes to document on every update
      const html = editor.getHTML();
      setDocument({
        [currentBlockId]: {
          type: 'Html',
          data: {
            ...document[currentBlockId].data,
            props: {
              ...props,
              contents: html,
            },
          },
        },
      });
    },
  });

  // Update editor content when props change externally
  useEffect(() => {
    if (editor && !editor.isFocused && contents !== editor.getHTML()) {
      editor.commands.setContent(contents);
    }
  }, [contents, editor]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    setIsEditing(true);
    // Focus the editor after state update
    setTimeout(() => {
      editor?.commands.focus('end');
    }, 0);
  }, [readOnly, editor]);

  const handleBlur = useCallback(() => {
    // Small delay to check if focus moved to toolbar or Radix portal
    setTimeout(() => {
      // Skip if we're in the middle of a toolbar interaction
      if (isToolbarInteraction.current) {
        isToolbarInteraction.current = false;
        return;
      }

      const activeElement = window.document.activeElement;
      const toolbarElement = window.document.querySelector('[data-html-toolbar]');
      const editorElement = window.document.querySelector('[data-html-editor]');

      // Check if focus is in Radix UI portals (dropdowns, popovers, etc.)
      const radixPortal = activeElement?.closest?.('[data-radix-popper-content-wrapper]');
      const radixDropdown = activeElement?.closest?.('[role="menu"]');
      const radixPopover = activeElement?.closest?.('[data-radix-popover-content]');

      // Don't close if focus is within the toolbar, editor, or Radix portals
      if (
        toolbarElement?.contains(activeElement) ||
        editorElement?.contains(activeElement) ||
        radixPortal ||
        radixDropdown ||
        radixPopover
      ) {
        return;
      }

      setIsEditing(false);
    }, 150);
  }, []);

  // Handle clicks outside to exit edit mode
  useEffect(() => {
    if (!isEditing) return;

    const handleClickOutside = (e: MouseEvent) => {
      const toolbarElement = window.document.querySelector('[data-html-toolbar]');
      const editorElement = window.document.querySelector('[data-html-editor]');
      const target = e.target as Element;

      // Check if click is inside Radix UI portals (dropdowns, popovers, etc.)
      const radixPortal = target.closest?.('[data-radix-popper-content-wrapper]');
      const radixDropdown = target.closest?.('[role="menu"]');
      const radixPopover = target.closest?.('[data-radix-popover-content]');
      const radixSelect = target.closest?.('[data-radix-select-content]');

      // Mark as toolbar interaction if clicking on Radix portals
      if (radixPortal || radixDropdown || radixPopover || radixSelect) {
        isToolbarInteraction.current = true;
        return;
      }

      if (
        !toolbarElement?.contains(target) &&
        !editorElement?.contains(target)
      ) {
        setIsEditing(false);
      }
    };

    window.document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditing]);

  // Apply styles to the editor
  const editorStyle: React.CSSProperties = {
    color: style?.color ?? undefined,
    backgroundColor: style?.backgroundColor ?? undefined,
    fontFamily: getFontFamily(style?.fontFamily),
    fontSize: style?.fontSize ?? undefined,
    textAlign: style?.textAlign ?? undefined,
    padding: getPadding(style?.padding),
    outline: 'none',
    minHeight: '1em',
  };

  // When editing, show the TipTap editor with toolbar
  if (isEditing && editor) {
    return (
      <div className="relative">
        {/* Floating Toolbar */}
        <div
          data-html-toolbar
          className="absolute -top-12 -left-[26px] z-50"
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent blur on toolbar click
            isToolbarInteraction.current = true;
          }}
        >
          <HtmlToolbar editor={editor} />
        </div>

        {/* Editor */}
        <div
          data-html-editor
          className="prose prose-sm max-w-none"
          style={editorStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <EditorContent
            editor={editor}
            onBlur={handleBlur}
          />
        </div>
      </div>
    );
  }

  // When not editing, render the normal Html block with double-click handler
  return (
    <div
      onDoubleClick={handleDoubleClick}
      style={{ cursor: readOnly ? 'default' : 'text' }}
    >
      <BaseHtml style={style} props={props} />
    </div>
  );
}

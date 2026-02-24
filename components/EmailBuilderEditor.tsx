'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { renderToStaticMarkup } from './email-builder/renderers';
import { type TReaderDocument } from './email-builder/Reader';
import { type TEditorConfiguration } from './email-builder/documents/editor/core';

import App from './email-builder/App';
import {
  useDocument,
  resetDocument,
} from './email-builder/documents/editor/EditorContext';

// Default empty email template
export const DEFAULT_EMAIL_BUILDER_CONTENT: TEditorConfiguration = {
  root: {
    type: 'EmailLayout',
    data: {
      backdropColor: '#F5F5F5',
      canvasColor: '#FFFFFF',
      textColor: '#242424',
      fontFamily: 'MODERN_SANS',
      childrenIds: ['content-block'],
    },
  },
  'content-block': {
    type: 'Text',
    data: {
      style: { padding: { top: 24, bottom: 24, left: 24, right: 24 } },
      props: { text: 'Start writing your email here...' },
    },
  },
};

interface EmailBuilderEditorProps {
  content: TEditorConfiguration | null;
  onChange: (content: TEditorConfiguration) => void;
  onPreviewHtml?: (html: string) => void;
}

// Inner component that has access to the Zustand store
function EmailBuilderInner({ content, onChange, onPreviewHtml }: EmailBuilderEditorProps) {
  const document = useDocument();
  const [isReady, setIsReady] = useState(false);
  const lastContent = useRef<TEditorConfiguration | null>(null);
  const lastSyncedContent = useRef<string | undefined>(undefined);

  // Initialize the editor with the provided content BEFORE paint
  useLayoutEffect(() => {
    const initialContent = content || DEFAULT_EMAIL_BUILDER_CONTENT;
    const contentKey = content ? JSON.stringify(content) : 'default';

    // Only reset if:
    // 1. This is first initialization (!isReady), OR
    // 2. The content prop changed from an EXTERNAL source (not from our own onChange call)
    const isExternalChange = contentKey !== lastSyncedContent.current;

    if (!isReady || isExternalChange) {
      resetDocument(initialContent);
      lastContent.current = initialContent;
      lastSyncedContent.current = contentKey;
      setIsReady(true);
    }
  }, [content, isReady]);

  // Sync document changes back to parent and generate preview
  useEffect(() => {
    if (!isReady) return;

    // Only call onChange if document actually changed from user edits
    const docString = JSON.stringify(document);
    const lastString = JSON.stringify(lastContent.current);

    if (docString !== lastString) {
      lastContent.current = document;
      // Track what we're syncing so we don't reset when it comes back as a prop
      lastSyncedContent.current = docString;
      onChange(document);

      // Generate preview HTML
      if (onPreviewHtml) {
        try {
          const html = renderToStaticMarkup(document as TReaderDocument, { rootBlockId: 'root' });
          onPreviewHtml(html);
        } catch (error) {
          console.error('Failed to render preview:', error);
        }
      }
    }
  }, [document, onChange, onPreviewHtml, isReady]);

  // Don't render until the document is initialized
  if (!isReady) {
    return null;
  }

  return <App />;
}

export function EmailBuilderEditor(props: EmailBuilderEditorProps) {
  return (
    <div className="email-builder-wrapper h-full overflow-auto">
      <Toaster position="top-center" />
      <EmailBuilderInner {...props} />
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { renderToStaticMarkup } from './email-builder/renderers';
import { type TReaderDocument } from './email-builder/Reader';
import { type TEditorConfiguration } from './email-builder/documents/editor/core';

import theme from './email-builder/theme';
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
  const isInitialized = useRef(false);
  const lastContent = useRef<TEditorConfiguration | null>(null);

  // Initialize the editor with the provided content
  useEffect(() => {
    if (!isInitialized.current && content) {
      resetDocument(content);
      isInitialized.current = true;
      lastContent.current = content;
    } else if (!isInitialized.current && !content) {
      resetDocument(DEFAULT_EMAIL_BUILDER_CONTENT);
      isInitialized.current = true;
      lastContent.current = DEFAULT_EMAIL_BUILDER_CONTENT;
    }
  }, [content]);

  // Sync document changes back to parent and generate preview
  useEffect(() => {
    if (!isInitialized.current) return;

    // Only call onChange if document actually changed
    const docString = JSON.stringify(document);
    const lastString = JSON.stringify(lastContent.current);

    if (docString !== lastString) {
      lastContent.current = document;
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
  }, [document, onChange, onPreviewHtml]);

  return <App />;
}

export function EmailBuilderEditor(props: EmailBuilderEditorProps) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="email-builder-wrapper h-full overflow-auto">
        <EmailBuilderInner {...props} />
      </div>
    </ThemeProvider>
  );
}

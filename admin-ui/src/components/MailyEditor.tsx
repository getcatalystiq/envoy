import { useCallback, useRef, useEffect } from 'react';
import { Editor } from '@maily-to/core';
// Import Maily CSS as raw string to bypass PostCSS/Tailwind processing
import mailyStyles from '@maily-to/core/style.css?raw';
import { Maily } from '@maily-to/render';
import type { MailyContent } from '@/api/client';

interface MailyEditorProps {
  content: MailyContent | null;
  onChange: (content: MailyContent) => void;
  onPreviewHtml?: (html: string) => void;
}

export function MailyEditor({ content, onChange, onPreviewHtml }: MailyEditorProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  // Inject Maily styles once on mount
  useEffect(() => {
    const styleId = 'maily-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = mailyStyles;
      document.head.appendChild(style);
    }
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCreate = useCallback((editor: any) => {
    editorRef.current = editor;
  }, []);

  const handleUpdate = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (editor: any) => {
      const json = editor.getJSON() as MailyContent;
      onChange(json);
    },
    [onChange]
  );

  // Generate preview HTML when content changes
  useEffect(() => {
    if (!content || !onPreviewHtml) return;

    const generatePreview = async () => {
      try {
        const maily = new Maily(content);
        const html = await maily.render({ pretty: true });
        onPreviewHtml(html);
      } catch (error) {
        console.error('Failed to render preview:', error);
      }
    };

    generatePreview();
  }, [content, onPreviewHtml]);

  return (
    <div className="maily-editor-wrapper h-full">
      <Editor
        contentJson={content || undefined}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        config={{
          hasMenuBar: true,
          spellCheck: true,
          wrapClassName: 'h-full',
          bodyClassName: 'min-h-[400px] p-4',
        }}
      />
    </div>
  );
}

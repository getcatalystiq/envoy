import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Eye, Code, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getDesignTemplate,
  updateDesignTemplate,
  previewDesignTemplate,
  type DesignTemplate,
  type MailyContent,
  type EditorType,
} from '@/api/client';
import CodeMirror from '@uiw/react-codemirror';
import { xml } from '@codemirror/lang-xml';
import { MailyEditor } from '@/components/MailyEditor';

export function DesignTemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<DesignTemplate | null>(null);
  const [name, setName] = useState('');
  const [editorType, setEditorType] = useState<EditorType>('maily');
  const [mjmlSource, setMjmlSource] = useState('');
  const [mailyContent, setMailyContent] = useState<MailyContent | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (id) loadTemplate();
  }, [id]);

  async function loadTemplate() {
    setLoading(true);
    try {
      const data = await getDesignTemplate(id!);
      setTemplate(data);
      setName(data.name);
      setEditorType(data.editor_type || 'maily');
      setMjmlSource(data.mjml_source || '');
      setMailyContent(data.maily_content);
      if (data.html_compiled) {
        setPreviewHtml(data.html_compiled);
      }
    } catch (error) {
      console.error('Failed to load template:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    if (editorType === 'maily') {
      // Maily preview is handled automatically by the MailyEditor component
      return;
    }

    setPreviewError(null);
    setPreviewing(true);
    try {
      const result = await previewDesignTemplate(mjmlSource);
      if (result.errors?.length) {
        setPreviewError(result.errors.join(', '));
      } else {
        setPreviewHtml(result.html);
      }
    } catch (error) {
      setPreviewError('Failed to generate preview');
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSave() {
    if (!template) return;
    setSaving(true);
    try {
      const updateData: Parameters<typeof updateDesignTemplate>[1] = { name };

      if (editorType === 'mjml') {
        updateData.mjml_source = mjmlSource;
      } else {
        updateData.maily_content = mailyContent || undefined;
      }

      const updated = await updateDesignTemplate(template.id, updateData);
      setTemplate(updated);
      setHasChanges(false);
      if (updated.html_compiled) {
        setPreviewHtml(updated.html_compiled);
      }
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setSaving(false);
    }
  }

  function handleMjmlSourceChange(value: string) {
    setMjmlSource(value);
    setHasChanges(true);
  }

  const handleMailyContentChange = useCallback((content: MailyContent) => {
    setMailyContent(content);
    setHasChanges(true);
  }, []);

  const handleMailyPreviewHtml = useCallback((html: string) => {
    setPreviewHtml(html);
    setPreviewError(null);
  }, []);

  function handleNameChange(value: string) {
    setName(value);
    setHasChanges(true);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-lg text-muted-foreground">Template not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/design-templates')}>
            Back to Templates
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="border-b px-4 py-3 flex items-center justify-between bg-background">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/design-templates')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            className="w-64 font-semibold"
          />
          <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
            {editorType === 'maily' ? (
              <>
                <FileText className="h-3 w-3" />
                <span>Visual Editor</span>
              </>
            ) : (
              <>
                <Code className="h-3 w-3" />
                <span>MJML</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editorType === 'mjml' && (
            <Button variant="outline" size="sm" onClick={handlePreview} disabled={previewing}>
              <Eye className="h-4 w-4 mr-2" />
              {previewing ? 'Loading...' : 'Preview'}
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={!hasChanges || saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex overflow-hidden">
        {/* Code/Visual Editor */}
        <div className="w-1/2 border-r flex flex-col">
          <div className="border-b px-4 py-2 text-sm font-medium bg-muted/30">
            {editorType === 'maily' ? 'Visual Editor' : 'MJML Source'}
          </div>
          <div className="flex-1 overflow-auto">
            {editorType === 'maily' ? (
              <MailyEditor
                content={mailyContent}
                onChange={handleMailyContentChange}
                onPreviewHtml={handleMailyPreviewHtml}
              />
            ) : (
              <CodeMirror
                value={mjmlSource}
                height="100%"
                extensions={[xml()]}
                onChange={handleMjmlSourceChange}
                className="h-full"
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  foldGutter: true,
                }}
              />
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="w-1/2 flex flex-col bg-muted/10">
          <div className="border-b px-4 py-2 text-sm font-medium bg-muted/30">Preview (600px)</div>
          {previewError ? (
            <div className="p-4 text-destructive bg-destructive/10">{previewError}</div>
          ) : (
            <div className="flex-1 overflow-auto p-4 flex justify-center">
              <div className="bg-white shadow-lg w-[600px] min-h-0">
                <iframe
                  srcDoc={previewHtml}
                  className="w-full h-full min-h-[600px] border-0"
                  title="Email Preview"
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

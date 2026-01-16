import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getDesignTemplate,
  updateDesignTemplate,
  type DesignTemplate,
} from '@/api/client';
import { EmailBuilderEditor } from '@/components/EmailBuilderEditor';
import type { TEditorConfiguration } from '@/components/email-builder/documents/editor/core';

export function DesignTemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<DesignTemplate | null>(null);
  const [name, setName] = useState('');
  const [builderContent, setBuilderContent] = useState<TEditorConfiguration | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      setBuilderContent(data.builder_content as TEditorConfiguration | null);
      if (data.html_compiled) {
        setPreviewHtml(data.html_compiled);
      }
    } catch (error) {
      console.error('Failed to load template:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!template) return;
    setSaving(true);
    try {
      const updated = await updateDesignTemplate(template.id, {
        name,
        builder_content: builderContent || undefined,
        html_compiled: previewHtml || undefined,
      });
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

  const handleBuilderContentChange = useCallback((content: TEditorConfiguration) => {
    setBuilderContent(content);
    setHasChanges(true);
  }, []);

  const handleBuilderPreviewHtml = useCallback((html: string) => {
    setPreviewHtml(html);
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
      <div className="border-b px-4 py-3 flex items-center justify-between bg-background relative z-50">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/design-templates')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            className="w-64 font-semibold"
          />
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-auto">
        <EmailBuilderEditor
          key={id}
          content={builderContent}
          onChange={handleBuilderContentChange}
          onPreviewHtml={handleBuilderPreviewHtml}
        />
      </div>
    </div>
  );
}

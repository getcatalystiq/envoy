/**
 * Skill Builder - Full-page editor for skill prompts.
 * Uses CodeMirror for the prompt editor.
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/api/client';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';

interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  prompt: string;
  enabled: boolean;
}

export function SkillBuilder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    if (id) {
      loadSkill();
    }
  }, [id]);

  const loadSkill = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<Skill>(`/maven/skills/${id}`);
      setSkill(data);
      setPrompt(data.prompt || '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePromptChange = (value: string) => {
    setPrompt(value);
    setHasUnsavedChanges(value !== skill?.prompt);
  };

  const handleSave = async () => {
    if (!skill) return;
    setIsSaving(true);
    setError(null);
    try {
      await api.patch(`/maven/skills/${skill.id}`, {
        prompt,
      });
      setSkill({ ...skill, prompt });
      setHasUnsavedChanges(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to leave?')) {
        return;
      }
    }
    navigate('/settings?tab=skills');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <p className="text-gray-600 mb-4">Skill not found</p>
        <Button variant="outline" onClick={() => navigate('/settings?tab=skills')}>
          Back to Skills
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-white">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{skill.name}</h1>
            <Badge variant={skill.enabled ? 'default' : 'secondary'}>
              {skill.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {hasUnsavedChanges && (
              <Badge variant="outline" className="text-yellow-600 border-yellow-600">
                Unsaved
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={!hasUnsavedChanges || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="px-4 py-2 bg-red-50 text-red-700 text-sm border-b border-red-200">
          {error}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={prompt}
          onChange={handlePromptChange}
          height="100%"
          className="h-full"
          theme="light"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
          }}
        />
      </div>

      {/* Footer with skill info */}
      <div className="px-4 py-2 border-t bg-white text-xs text-gray-500 flex items-center gap-4">
        <span>Slug: <code className="font-mono bg-gray-100 px-1 rounded">{skill.slug}</code></span>
        {skill.description && <span>Description: {skill.description}</span>}
      </div>
    </div>
  );
}

'use client';

/**
 * Skill Builder - Full-page editor for skills.
 * Supports both simple prompt editing and file-based skills with full file browser.
 */
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { ArrowLeft, Save, Loader2, Upload } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { SkillBuilderProvider, useSkillBuilder } from './skill-builder/SkillBuilderContext';
import { SkillFileBrowser } from './skill-builder/SkillFileBrowser';
import { SkillCodeEditor } from './skill-builder/SkillCodeEditor';
import type { Skill } from './skill-builder/types';

// Inner component for file-based skills
function FileBasedSkillEditor() {
  const { state, saveAllFiles, publishSkill } = useSkillBuilder();
  const router = useRouter();
  const hasUnsavedChanges = state.unsavedChanges.size > 0;

  const handleBack = () => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to leave?')) {
        return;
      }
    }
    router.push('/settings?tab=ai-skills');
  };

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
            <h1 className="text-lg font-semibold">{state.skillName}</h1>
            <Badge variant={state.draftStatus === 'published' ? 'default' : 'secondary'}>
              {state.draftStatus === 'published' ? 'Published' : 'Draft'}
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
            variant="outline"
            onClick={saveAllFiles}
            disabled={!hasUnsavedChanges || state.isSaving}
          >
            {state.isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save All
              </>
            )}
          </Button>
          <Button
            onClick={publishSkill}
            disabled={state.isPublishing}
          >
            {state.isPublishing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Publishing...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Publish
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Error message */}
      {state.publishError && (
        <div className="px-4 py-2 bg-red-50 text-red-700 text-sm border-b border-red-200">
          {state.publishError}
        </div>
      )}

      {/* Two-panel layout: file browser | code editor */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 flex-shrink-0">
          <SkillFileBrowser />
        </div>
        <div className="flex-1">
          <SkillCodeEditor />
        </div>
      </div>

      {/* Footer with skill info */}
      <div className="px-4 py-2 border-t bg-white text-xs text-gray-500 flex items-center gap-4">
        <span>Slug: <code className="font-mono bg-gray-100 px-1 rounded">{state.skillSlug}</code></span>
      </div>
    </div>
  );
}

// Simple prompt editor (existing functionality)
function SimplePromptEditor({ skill, onSkillUpdate }: { skill: Skill; onSkillUpdate: (skill: Skill) => void }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(skill.prompt || '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasUnsavedChanges = prompt !== skill.prompt;

  const handlePromptChange = (value: string) => {
    setPrompt(value);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api.patch(`/agentplane/skills/${skill.id}`, { prompt });
      onSkillUpdate({ ...skill, prompt });
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
    router.push('/settings?tab=ai-skills');
  };

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

export function SkillBuilder() {
  const { id } = useParams();
  const router = useRouter();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      loadSkill();
    }
  }, [id]);

  const loadSkill = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<Skill>(`/agentplane/skills/${id}`);
      setSkill(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <p className="text-gray-600 mb-4">{error || 'Skill not found'}</p>
        <Button variant="outline" onClick={() => router.push('/settings?tab=skills')}>
          Back to Skills
        </Button>
      </div>
    );
  }

  // File-based skill (prompt is null)
  if (skill.prompt === null) {
    return (
      <SkillBuilderProvider skill={skill}>
        <FileBasedSkillEditor />
      </SkillBuilderProvider>
    );
  }

  // Simple prompt-based skill
  return <SimplePromptEditor skill={skill} onSkillUpdate={setSkill} />;
}

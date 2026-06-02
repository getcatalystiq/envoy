'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';

export function AgentInstructions() {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    setUnconfigured(false);
    api
      .get<{ instructions: string | null }>('/agent/instructions')
      .then((data) => {
        const text = data.instructions ?? '';
        setContent(text);
        setOriginal(text);
      })
      .catch((err) => {
        if ((err as { status?: number }).status === 503) {
          setUnconfigured(true);
        } else {
          setLoadError(formatApiError(err));
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/agent/instructions', { content });
      setOriginal(content);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (unconfigured) {
    return (
      <p className="text-sm text-muted-foreground">
        Agent not configured — set an Agent ID in the{' '}
        <Link href="/settings?tab=instructions" className="underline">
          Agent Config
        </Link>{' '}
        above first.
      </p>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  const hasChanges = content !== original;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The system prompt guides how your agent generates content. Saving updates the
        agent&apos;s prompt and records who changed it.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={20}
        className="w-full font-mono text-sm border rounded-md p-3 bg-background"
        placeholder="No system prompt set"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? (
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
  );
}

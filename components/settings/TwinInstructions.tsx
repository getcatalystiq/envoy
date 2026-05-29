'use client';
import { useEffect, useState } from 'react';
import { api, formatApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';

export function TwinInstructions() {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ instructions: { content: string } | null }>('/twin/instructions')
      .then((data) => {
        const text = data.instructions?.content ?? '';
        setContent(text);
        setOriginal(text);
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/twin/instructions', { content });
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

  const hasChanges = content !== original;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Instructions guide how your Twin agent generates content. Updates create a new
        version in the agent&apos;s history.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={20}
        className="w-full font-mono text-sm border rounded-md p-3 bg-background"
        placeholder="Describe what your agent should do..."
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

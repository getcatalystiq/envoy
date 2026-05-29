'use client';
import { useEffect, useState } from 'react';
import { api, formatApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';

interface OrganizationResponse {
  twin_agent_id?: string | null;
  twin_api_key_configured?: boolean;
}

export function TwinAgentConfig() {
  const [agentId, setAgentId] = useState('');
  const [originalAgentId, setOriginalAgentId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .get<OrganizationResponse>('/organization')
      .then((data) => {
        const value = data.twin_agent_id ?? '';
        setAgentId(value);
        setOriginalAgentId(value);
        setApiKeyConfigured(Boolean(data.twin_api_key_configured));
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload: Record<string, unknown> = {};
      const nextAgentId = agentId.trim();
      if (nextAgentId !== originalAgentId) {
        payload.twin_agent_id = nextAgentId.length > 0 ? nextAgentId : null;
      }
      if (editingApiKey) {
        const trimmed = apiKey.trim();
        payload.twin_api_key = trimmed.length > 0 ? trimmed : null;
      }
      const data = await api.patch<OrganizationResponse>('/organization', payload);
      const updatedAgent = data.twin_agent_id ?? '';
      setAgentId(updatedAgent);
      setOriginalAgentId(updatedAgent);
      setApiKeyConfigured(Boolean(data.twin_api_key_configured));
      setApiKey('');
      setEditingApiKey(false);
      setSaved(true);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const clearApiKey = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api.patch<OrganizationResponse>('/organization', {
        twin_api_key: null,
      });
      setApiKeyConfigured(Boolean(data.twin_api_key_configured));
      setApiKey('');
      setEditingApiKey(false);
      setSaved(true);
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

  const hasAgentChange = agentId.trim() !== originalAgentId;
  const hasApiKeyChange = editingApiKey;
  const hasChanges = hasAgentChange || hasApiKeyChange;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Twin agent ID</h2>
          <p className="text-sm text-muted-foreground">
            The deployed Twin agent ID that handles content generation for this
            organization. Find it in your{' '}
            <a
              href="https://builder.twin.so"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Twin builder
            </a>
            . Leave empty to disable AI personalization.
          </p>
        </div>
        <input
          type="text"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setSaved(false);
          }}
          placeholder="agent_xxxxxxxxxxxx"
          className="w-full font-mono text-sm border rounded-md px-3 py-2 bg-background"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Twin API key (optional)</h2>
          <p className="text-sm text-muted-foreground">
            Per-organization Twin API key. When set, this overrides the
            deployment-wide TWIN_API_KEY environment variable for this
            organization. Useful when each customer brings their own Twin
            account.
          </p>
        </div>
        {!editingApiKey ? (
          <div className="flex items-center gap-3">
            <code className="flex-1 font-mono text-sm border rounded-md px-3 py-2 bg-muted text-muted-foreground">
              {apiKeyConfigured ? '•••••••••••• (configured)' : 'Using TWIN_API_KEY env var'}
            </code>
            <Button
              variant="outline"
              onClick={() => {
                setEditingApiKey(true);
                setApiKey('');
                setSaved(false);
              }}
            >
              {apiKeyConfigured ? 'Replace' : 'Set'}
            </Button>
            {apiKeyConfigured && (
              <Button variant="outline" onClick={clearApiKey} disabled={saving}>
                Clear
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSaved(false);
              }}
              placeholder="tw_live_..."
              className="w-full font-mono text-sm border rounded-md px-3 py-2 bg-background"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingApiKey(false);
                  setApiKey('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && (
        <p className="text-sm text-muted-foreground">Saved.</p>
      )}
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

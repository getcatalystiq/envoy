'use client';
import { useEffect, useState } from 'react';
import { api, formatApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';

interface OrganizationResponse {
  agent_id?: string | null;
  environment_id?: string | null;
  vault_id?: string | null;
}

export function AgentConfig() {
  const [agentId, setAgentId] = useState('');
  const [originalAgentId, setOriginalAgentId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [originalEnvironmentId, setOriginalEnvironmentId] = useState('');
  const [vaultId, setVaultId] = useState('');
  const [originalVaultId, setOriginalVaultId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentIdError, setAgentIdError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api
      .get<OrganizationResponse>('/organization')
      .then((data) => {
        const a = data.agent_id ?? '';
        const e = data.environment_id ?? '';
        const v = data.vault_id ?? '';
        setAgentId(a);
        setOriginalAgentId(a);
        setEnvironmentId(e);
        setOriginalEnvironmentId(e);
        setVaultId(v);
        setOriginalVaultId(v);
      })
      .catch((err) => setLoadError(formatApiError(err)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setAgentIdError(null);
    setSaved(false);
    try {
      const payload: Record<string, unknown> = {};
      const nextAgent = agentId.trim();
      if (nextAgent !== originalAgentId) {
        payload.agent_id = nextAgent.length > 0 ? nextAgent : null;
      }
      const nextEnv = environmentId.trim();
      if (nextEnv !== originalEnvironmentId) {
        // Empty clears the override → the deployment default env is used.
        payload.environment_id = nextEnv.length > 0 ? nextEnv : null;
      }
      const nextVault = vaultId.trim();
      if (nextVault !== originalVaultId) {
        // Empty clears the vault → no vault attached to sessions.
        payload.vault_id = nextVault.length > 0 ? nextVault : null;
      }
      const data = await api.patch<OrganizationResponse>('/organization', payload);
      const a = data.agent_id ?? '';
      const e = data.environment_id ?? '';
      const v = data.vault_id ?? '';
      setAgentId(a);
      setOriginalAgentId(a);
      setEnvironmentId(e);
      setOriginalEnvironmentId(e);
      setVaultId(v);
      setOriginalVaultId(v);
      setSaved(true);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        setAgentIdError(
          'This agent ID is already in use by another organization. Enter a different agent ID.',
        );
      } else {
        setError(formatApiError(err));
      }
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

  if (loadError) {
    return (
      <div className="space-y-3 py-6">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  const hasChanges =
    agentId.trim() !== originalAgentId ||
    environmentId.trim() !== originalEnvironmentId ||
    vaultId.trim() !== originalVaultId;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Agent ID</h2>
          <p className="text-sm text-muted-foreground">
            The Claude Managed Agent that handles content generation for this
            organization. Find it in the{' '}
            <a
              href="https://console.anthropic.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Anthropic Console
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
            setAgentIdError(null);
          }}
          placeholder="agent_xxxxxxxxxxxx"
          className="w-full font-mono text-sm border rounded-md px-3 py-2 bg-background"
          autoComplete="off"
          spellCheck={false}
        />
        {agentIdError && <p className="text-sm text-destructive">{agentIdError}</p>}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Environment ID</h2>
          <p className="text-sm text-muted-foreground">
            The Managed Agents environment the session runs in. Leave empty to use
            the deployment default.
          </p>
        </div>
        <input
          type="text"
          value={environmentId}
          onChange={(e) => {
            setEnvironmentId(e.target.value);
            setSaved(false);
          }}
          placeholder="env_xxxxxxxxxxxx"
          className="w-full font-mono text-sm border rounded-md px-3 py-2 bg-background"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Vault ID</h2>
          <p className="text-sm text-muted-foreground">
            The Managed Agents vault holding credentials your agent&apos;s MCP
            servers (e.g. firecrawl) need. Leave empty if the agent uses no
            credentialed tools.
          </p>
        </div>
        <input
          type="text"
          value={vaultId}
          onChange={(e) => {
            setVaultId(e.target.value);
            setSaved(false);
          }}
          placeholder="vault_xxxxxxxxxxxx"
          className="w-full font-mono text-sm border rounded-md px-3 py-2 bg-background"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-muted-foreground">Saved.</p>}
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

/**
 * Connectors - view and manage toolkit connections via AgentPlane.
 * Supports OAuth, API key, and no-auth connector types.
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/api/client';
import { Plug, PlugZap, Loader2, CheckCircle, XCircle, Key, Shield } from 'lucide-react';

type AuthScheme = 'OAUTH2' | 'OAUTH1' | 'API_KEY' | 'NO_AUTH' | 'OTHER';

interface Connector {
  slug: string;
  name: string;
  logo: string;
  authScheme: AuthScheme;
  authConfigId: string | null;
  connectedAccountId: string | null;
  connectionStatus: string | null;
}

export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<string | null>(null);
  const [apiKeyDialog, setApiKeyDialog] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConnectors = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<{ connectors: Connector[] }>('/agentplane/connectors');
      setConnectors(data.connectors || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConnectors();
  }, [loadConnectors]);

  // Listen for OAuth callback postMessage with origin validation
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // SECURITY: Always validate origin
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'agentplane_oauth_callback') return;

      if (event.data.success) {
        setConnectingSlug(null);
        loadConnectors();
      } else {
        setError(event.data.error || 'OAuth failed');
        setConnectingSlug(null);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [loadConnectors]);

  const handleOAuthConnect = async (slug: string) => {
    setConnectingSlug(slug);
    setError(null);
    try {
      const data = await api.post<{ redirect_url: string }>(
        `/agentplane/connectors/${slug}/oauth`
      );

      if (data.redirect_url) {
        const popup = window.open(
          data.redirect_url,
          'agentplane_oauth',
          'width=600,height=700,popup'
        );

        if (!popup) {
          throw new Error('Popup blocked. Please allow popups for this site.');
        }

        // Poll for popup close as fallback
        const pollTimer = setInterval(() => {
          if (popup.closed) {
            clearInterval(pollTimer);
            loadConnectors();
            setConnectingSlug(null);
          }
        }, 1000);
      }
    } catch (err) {
      setError((err as Error).message);
      setConnectingSlug(null);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyDialog || !apiKeyValue) return;
    setIsSavingKey(true);
    setError(null);
    try {
      await api.post(`/agentplane/connectors/${apiKeyDialog}/api-key`, {
        api_key: apiKeyValue,
      });
      setApiKeyDialog(null);
      setApiKeyValue('');
      await loadConnectors();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleDisconnect = async (slug: string) => {
    setError(null);
    try {
      await api.delete(`/agentplane/connectors/${slug}`);
      setDisconnectConfirm(null);
      await loadConnectors();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const getAuthBadge = (scheme: AuthScheme) => {
    switch (scheme) {
      case 'OAUTH2':
      case 'OAUTH1':
        return <Badge variant="outline" className="text-blue-600 border-blue-200"><Shield className="w-3 h-3 mr-1" />OAuth</Badge>;
      case 'API_KEY':
        return <Badge variant="outline" className="text-amber-600 border-amber-200"><Key className="w-3 h-3 mr-1" />API Key</Badge>;
      case 'NO_AUTH':
        return <Badge variant="outline" className="text-green-600 border-green-200">No Auth</Badge>;
      default:
        return <Badge variant="outline">{scheme}</Badge>;
    }
  };

  const isConnected = (c: Connector) => c.connectionStatus === 'ACTIVE';

  if (isLoading && connectors.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="w-5 h-5" />
          Connectors
        </CardTitle>
        <CardDescription>
          Connect external services to enhance AI capabilities
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        {connectors.length === 0 ? (
          <div className="text-center py-8">
            <Plug className="w-12 h-12 mx-auto text-gray-300 mb-4" />
            <p className="text-gray-500">
              No connectors configured for this organization.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {connectors.map((connector) => (
              <div
                key={connector.slug}
                className="flex flex-col p-4 bg-gray-50 rounded-lg border"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border">
                    {connector.logo ? (
                      <img src={connector.logo} alt={connector.name} className="w-6 h-6" />
                    ) : (
                      <Plug className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{connector.name}</p>
                    <p className="text-xs text-gray-400 font-mono">{connector.slug}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 mb-3">
                  {getAuthBadge(connector.authScheme)}
                  {isConnected(connector) ? (
                    <Badge variant="default" className="gap-1">
                      <CheckCircle className="w-3 h-3" />
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      <XCircle className="w-3 h-3" />
                      Not connected
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-auto">
                  {isConnected(connector) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setDisconnectConfirm(connector.slug)}
                    >
                      Disconnect
                    </Button>
                  ) : connector.authScheme === 'API_KEY' ? (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => { setApiKeyDialog(connector.slug); setApiKeyValue(''); }}
                    >
                      <Key className="w-4 h-4 mr-1" />
                      Set API Key
                    </Button>
                  ) : connector.authScheme === 'NO_AUTH' ? (
                    <Badge variant="outline" className="w-full justify-center py-1">Ready</Badge>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => handleOAuthConnect(connector.slug)}
                      disabled={connectingSlug === connector.slug}
                    >
                      {connectingSlug === connector.slug ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-1" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          <PlugZap className="w-4 h-4 mr-1" />
                          Connect
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* API Key Dialog */}
      <Dialog open={!!apiKeyDialog} onOpenChange={() => setApiKeyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="api-key">API Key for {apiKeyDialog}</Label>
              <Input
                id="api-key"
                type="password"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                placeholder="Enter API key..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApiKeyDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveApiKey}
              disabled={!apiKeyValue || isSavingKey}
            >
              {isSavingKey ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={!!disconnectConfirm} onOpenChange={() => setDisconnectConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Connector</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            Are you sure you want to remove this connector? AI features that depend on it will stop working.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectConfirm && handleDisconnect(disconnectConfirm)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

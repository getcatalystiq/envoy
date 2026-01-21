/**
 * MCP Servers - view and manage connector connections.
 * Uses service OAuth flow: admin authenticates, token stored for envoy-service.
 * Pattern matches Maven widget ConnectorsContext.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/api/client';
import { Plug, PlugZap, Loader2, CheckCircle, XCircle } from 'lucide-react';

interface Connector {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  connected: boolean;
  requires_oauth: boolean;
}

export function MavenConnectorsTab() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConnectors = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<{ connectors: Connector[] }>('/maven/connectors');
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

  // Refresh on window focus (to catch OAuth completion)
  useEffect(() => {
    const handleFocus = () => {
      // Only refresh if we were connecting (OAuth popup flow)
      if (connectingId) {
        loadConnectors();
        setConnectingId(null);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [loadConnectors, connectingId]);

  // Listen for OAuth callback postMessage
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'maven_oauth_callback') {
        if (event.data.success) {
          setConnectingId(null);
          loadConnectors();
        } else {
          setError(event.data.error || 'OAuth failed');
          setConnectingId(null);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [loadConnectors]);

  const handleConnect = async (connectorId: string) => {
    setConnectingId(connectorId);
    setError(null);
    try {
      const data = await api.post<{ authorization_url: string }>(
        `/maven/connectors/${connectorId}/connect`
      );

      if (data.authorization_url) {
        // Open OAuth popup (same pattern as Maven widget)
        const popup = window.open(
          data.authorization_url,
          'maven_oauth',
          'width=600,height=700,popup'
        );

        if (!popup) {
          throw new Error('Popup blocked. Please allow popups for this site.');
        }
      }
    } catch (err) {
      setError((err as Error).message);
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (connectorId: string) => {
    setDisconnectingId(connectorId);
    setError(null);
    try {
      await api.post(`/maven/connectors/${connectorId}/disconnect`);
      setDisconnectConfirm(null);
      await loadConnectors();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDisconnectingId(null);
    }
  };

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
          MCP Servers
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
              No MCP servers configured for this organization.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {connectors.map((connector) => (
              <div
                key={connector.id}
                className="flex items-center justify-between p-4 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border">
                    {connector.icon ? (
                      <span className="text-xl">{connector.icon}</span>
                    ) : (
                      <Plug className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium">{connector.name}</p>
                    {connector.description && (
                      <p className="text-sm text-gray-500">{connector.description}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {connector.connected ? (
                    <>
                      <Badge variant="default" className="gap-1">
                        <CheckCircle className="w-3 h-3" />
                        Connected
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDisconnectConfirm(connector.id)}
                        disabled={disconnectingId === connector.id}
                      >
                        {disconnectingId === connector.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          'Disconnect'
                        )}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary" className="gap-1">
                        <XCircle className="w-3 h-3" />
                        Not connected
                      </Badge>
                      <Button
                        size="sm"
                        onClick={() => handleConnect(connector.id)}
                        disabled={connectingId === connector.id}
                      >
                        {connectingId === connector.id ? (
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
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={!!disconnectConfirm} onOpenChange={() => setDisconnectConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Server</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            Are you sure you want to disconnect this MCP server? AI features that depend on it will stop working.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectConfirm && handleDisconnect(disconnectConfirm)}
              disabled={disconnectingId === disconnectConfirm}
            >
              {disconnectingId === disconnectConfirm ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Disconnecting...
                </>
              ) : (
                'Disconnect'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

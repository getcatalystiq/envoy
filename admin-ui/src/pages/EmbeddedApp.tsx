import { useEffect, useState } from 'react';
import { setExternalToken, isEmbedded, fetchUserInfo } from '@/auth/oauth';
import { useSetUser } from '@/auth/AuthContext';
import { Layout } from '@/components/Layout';
import { Dashboard } from './Dashboard';

/**
 * EmbeddedApp - Wrapper for Envoy when embedded in Maven widget
 *
 * Handles:
 * 1. Sending maven_app_ready when loaded
 * 2. Receiving auth context from parent via maven_app_init
 * 3. Rendering the main app content
 */
export function EmbeddedApp() {
  const setUser = useSetUser();
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if we're in an iframe
    if (!isEmbedded()) {
      // Not embedded, redirect to dashboard
      window.location.href = '/dashboard';
      return;
    }

    // Handle messages from parent Maven widget
    const handleMessage = async (event: MessageEvent) => {
      const { data } = event;

      if (data?.type === 'maven_app_init') {
        console.log('[Envoy Embedded] Received maven_app_init from:', event.origin);
        console.log('[Envoy Embedded] Data keys:', Object.keys(data));
        console.log('[Envoy Embedded] Has token:', !!data.token);
        console.log('[Envoy Embedded] Has connectorToken:', !!data.connectorToken);

        // Receive auth context from Maven widget
        if (data.token || data.connectorToken) {
          const token = data.connectorToken || data.token;
          console.log('[Envoy Embedded] Using token type:', data.connectorToken ? 'connectorToken' : 'token');
          console.log('[Envoy Embedded] Token length:', token?.length);
          setExternalToken(token, 3600);

          try {
            // Fetch user info with the new token
            console.log('[Envoy Embedded] Fetching user info...');
            const userInfo = await fetchUserInfo();
            setUser(userInfo);
            setIsReady(true);
            console.log('[Envoy Embedded] Auth successful, user:', userInfo.email);
          } catch (err) {
            console.error('[Envoy Embedded] Failed to fetch user info:', err);
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            console.error('[Envoy Embedded] Error details:', errorMsg);
            setError(`Authentication failed: ${errorMsg}`);
          }
        } else {
          console.error('[Envoy Embedded] No token in maven_app_init');
          setError('No authentication token provided');
        }
      }
    };

    window.addEventListener('message', handleMessage);

    // Signal to parent that we're ready to receive initialization
    // Use '*' for ready signal since we don't know parent origin yet
    window.parent.postMessage({ type: 'maven_app_ready' }, '*');
    console.log('[Envoy Embedded] Sent maven_app_ready');

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [setUser]);

  // Show error if auth failed
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <div className="text-center max-w-md p-6">
          <div className="text-red-500 text-xl mb-4">Authentication Error</div>
          <p className="text-gray-600 mb-4">{error}</p>
          <p className="text-sm text-gray-500">
            Please ensure the Envoy connector is properly configured in Maven.
          </p>
        </div>
      </div>
    );
  }

  // Show loading until we receive auth from parent
  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Connecting to Maven...</p>
        </div>
      </div>
    );
  }

  // Render the app with embedded flag
  return (
    <Layout embedded>
      <Dashboard />
    </Layout>
  );
}

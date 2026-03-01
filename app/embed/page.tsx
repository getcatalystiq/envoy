'use client';
import { useEffect, useState } from 'react';
import { setExternalToken, isEmbedded, fetchUserInfo } from '@/lib/auth-client';
import { useSetUser } from '@/lib/auth-context';
import { Layout } from '@/components/Layout';
import DashboardPage from '@/app/(admin)/dashboard/page';

/**
 * EmbeddedApp - Wrapper for Envoy when embedded in external widget
 *
 * Handles:
 * 1. Sending envoy_app_ready when loaded
 * 2. Receiving auth context from parent via envoy_app_init
 * 3. Rendering the main app content
 */
export default function EmbedPage() {
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

    // Handle messages from parent widget
    const handleMessage = async (event: MessageEvent) => {
      const { data } = event;

      if (data?.type === 'envoy_app_init') {
        // Receive auth context from parent widget
        if (data.token || data.connectorToken) {
          const token = data.connectorToken || data.token;
          setExternalToken(token, 3600);

          try {
            const userInfo = await fetchUserInfo();
            setUser(userInfo);
            setIsReady(true);
          } catch (err) {
            console.error('[Envoy] Failed to authenticate:', err instanceof Error ? err.message : err);
            setError(`Authentication failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        } else {
          setError('No authentication token provided');
        }
      }
    };

    window.addEventListener('message', handleMessage);

    // Signal to parent that we're ready to receive initialization
    // Use '*' for ready signal since we don't know parent origin yet
    window.parent.postMessage({ type: 'envoy_app_ready' }, '*');

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
            Please ensure the Envoy connector is properly configured.
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
          <p className="text-gray-600">Connecting...</p>
        </div>
      </div>
    );
  }

  // Render the app with embedded flag
  return (
    <Layout embedded>
      <DashboardPage />
    </Layout>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { handleCallback } from '@/auth/oauth';
import { useSetUser } from '@/auth/AuthContext';
import { AlertCircle, Mail } from 'lucide-react';

export function Callback() {
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const setUser = useSetUser();

  useEffect(() => {
    const processCallback = async () => {
      try {
        const userInfo = await handleCallback();
        setUser(userInfo);
        navigate('/dashboard', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    };

    processCallback();
  }, [navigate, setUser]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
              <Mail className="w-6 h-6 text-white" />
            </div>
            <span className="font-semibold text-xl">Envoy</span>
          </div>
          <div className="flex items-center justify-center gap-2 p-4 text-red-600 bg-red-50 rounded-lg">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => navigate('/login')}
            className="mt-4 text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-4">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Mail className="w-6 h-6 text-white" />
          </div>
          <span className="font-semibold text-xl">Envoy</span>
        </div>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
        <p className="mt-4 text-gray-600">Signing you in...</p>
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const { isLoggedIn, login } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoggedIn) {
      router.push('/dashboard');
      return;
    }

    const initiateLogin = async () => {
      try {
        await login();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start login');
      }
    };

    initiateLogin();
  }, [isLoggedIn, login, router]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted px-4">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <img src="/logo.png" alt="Envoy" className="w-10 h-10 rounded-lg" />
            <span className="font-semibold text-xl">Envoy</span>
          </div>
          <div className="flex items-center justify-center gap-2 p-4 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 rounded-lg">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-4">
          <img src="/logo.png" alt="Envoy" className="w-10 h-10 rounded-lg" />
          <span className="font-semibold text-xl">Envoy</span>
        </div>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
        <p className="mt-4 text-muted-foreground">Redirecting to login...</p>
      </div>
    </div>
  );
}

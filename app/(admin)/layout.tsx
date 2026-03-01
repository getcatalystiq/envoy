'use client';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Layout } from '@/components/Layout';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, isLoading } = useAuth();
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isLoggedIn) {
    router.push('/login');
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <Layout>{children}</Layout>;
}

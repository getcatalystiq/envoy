'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { isEmbedded } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import {
  LayoutDashboard,
  Users,
  LogOut,
  Menu,
  X,
  Settings,
  Inbox,
  GitBranch,
  Palette,
} from 'lucide-react';
import { useState, createContext, useContext } from 'react';
import { cn } from '@/lib/utils';

// Context for embedded mode to expose sidebar toggle
interface LayoutContextValue {
  openSidebar: () => void;
  isEmbedded: boolean;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function useLayout() {
  return useContext(LayoutContext);
}

// Hamburger button component for pages to use in embedded mode
export function MenuButton({ className }: { className?: string }) {
  const layout = useLayout();
  if (!layout?.isEmbedded) return null;

  return (
    <button
      onClick={layout.openSidebar}
      className={cn(
        'p-1.5 -ml-1.5 rounded-lg hover:bg-muted transition-colors',
        className
      )}
      aria-label="Open menu"
    >
      <Menu className="w-5 h-5 text-muted-foreground" />
    </button>
  );
}

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Outbox', href: '/outbox', icon: Inbox },
  { name: 'Targets', href: '/targets', icon: Users },
  { name: 'Sequences', href: '/sequences', icon: GitBranch },
  { name: 'Design', href: '/design-templates', icon: Palette },
  { name: 'Settings', href: '/settings', icon: Settings },
];

interface LayoutProps {
  children: React.ReactNode;
  embedded?: boolean;
}

export function Layout({ children, embedded = false }: LayoutProps) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auto-detect embedded mode when in iframe
  const isInEmbeddedMode = embedded || isEmbedded();

  // In embedded mode, render with collapsible sidebar (no separate header)
  if (isInEmbeddedMode) {
    const contextValue: LayoutContextValue = {
      openSidebar: () => setSidebarOpen(true),
      isEmbedded: true,
    };

    return (
      <LayoutContext.Provider value={contextValue}>
        <div className="min-h-screen bg-background">
          {/* Sidebar backdrop */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          {/* Sidebar */}
          <aside
            className={cn(
              'fixed inset-y-0 left-0 z-50 w-64 bg-background border-r transform transition-transform duration-200 ease-in-out',
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            )}
          >
            <div className="flex flex-col h-full">
              {/* Header with close button */}
              <div className="flex items-center justify-end h-14 px-4 border-b">
                <button onClick={() => setSidebarOpen(false)}>
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Navigation */}
              <nav className="flex-1 px-3 py-3 space-y-0.5">
                {navigation.map((item) => {
                  const isActive = pathname === item.href;

                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-muted'
                      )}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon className="w-5 h-5" />
                      {item.name}
                    </Link>
                  );
                })}
              </nav>

              {/* User section */}
              <div className="p-3 border-t">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-xs font-medium text-primary">
                      {user?.email?.[0]?.toUpperCase() || 'U'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{user?.email}</p>
                    <p className="text-xs text-muted-foreground truncate">{user?.org_name}</p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </aside>

          {/* Main content - children render their own header with MenuButton */}
          <main className="p-4">{children}</main>
        </div>
      </LayoutContext.Provider>
    );
  }

  return (
    <div className="min-h-screen bg-muted">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-background border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-6 border-b">
            <Link href="/dashboard" className="flex items-center gap-2">
              <img src="/logo.png" alt="Envoy" className="w-8 h-8 rounded-lg" />
              <span className="font-semibold text-lg">Envoy</span>
            </Link>
            <button
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-4 py-4 space-y-1">
            {navigation.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                  onClick={() => setSidebarOpen(false)}
                >
                  <item.icon className="w-5 h-5" />
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* User section */}
          <div className="p-4 border-t">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="text-sm font-medium text-primary">
                  {user?.email?.[0]?.toUpperCase() || 'U'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.email}</p>
                <p className="text-xs text-muted-foreground truncate">{user?.org_name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 justify-start"
                onClick={logout}
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </Button>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 bg-background border-b lg:hidden">
          <div className="flex items-center justify-between h-16 px-4">
            <button onClick={() => setSidebarOpen(true)}>
              <Menu className="w-6 h-6" />
            </button>
            <Link href="/dashboard" className="flex items-center gap-2">
              <img src="/logo.png" alt="Envoy" className="w-8 h-8 rounded-lg" />
              <span className="font-semibold">Envoy</span>
            </Link>
            <div className="w-6" />
          </div>
        </header>

        {/* Page content */}
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}

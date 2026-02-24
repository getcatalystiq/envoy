'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { isEmbedded } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  Mail,
  Users,
  FileText,
  LogOut,
  Menu,
  X,
  Settings,
  Inbox,
  GitBranch,
  Palette,
  Search,
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
        'p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100 transition-colors',
        className
      )}
      aria-label="Open menu"
    >
      <Menu className="w-5 h-5 text-gray-600" />
    </button>
  );
}

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Outbox', href: '/outbox', icon: Inbox },
  { name: 'Targets', href: '/targets', icon: Users },
  { name: 'Sequences', href: '/sequences', icon: GitBranch },
  { name: 'Campaigns', href: '/campaigns', icon: Mail, comingSoon: true },
  { name: 'Prospecting', href: '/prospecting', icon: Search, comingSoon: true },
  { name: 'Design', href: '/design-templates', icon: Palette },
  { name: 'Content', href: '/content', icon: FileText, comingSoon: true },
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
        <div className="min-h-screen bg-white">
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
              'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r transform transition-transform duration-200 ease-in-out',
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

                  if (item.comingSoon) {
                    return (
                      <div
                        key={item.name}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 cursor-not-allowed"
                      >
                        <item.icon className="w-5 h-5" />
                        <span>{item.name}</span>
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-gray-600 hover:bg-gray-100'
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
                    <p className="text-xs text-gray-500 truncate">{user?.org_name}</p>
                  </div>
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
    <div className="min-h-screen bg-gray-50">
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
          'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-6 border-b">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <Mail className="w-5 h-5 text-white" />
              </div>
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

              if (item.comingSoon) {
                return (
                  <div
                    key={item.name}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 cursor-not-allowed"
                  >
                    <item.icon className="w-5 h-5" />
                    <span>{item.name}</span>
                    <span className="text-[10px] text-gray-400">(coming soon)</span>
                  </div>
                );
              }

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-gray-600 hover:bg-gray-100'
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
                <p className="text-xs text-gray-500 truncate">{user?.org_name}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={logout}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 bg-white border-b lg:hidden">
          <div className="flex items-center justify-between h-16 px-4">
            <button onClick={() => setSidebarOpen(true)}>
              <Menu className="w-6 h-6" />
            </button>
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <Mail className="w-5 h-5 text-white" />
              </div>
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

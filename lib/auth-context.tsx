'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  bootstrapSession,
  isAuthenticated,
  getAccessToken,
  startAuthFlow,
  logout as oauthLogout,
  startTokenRefreshTimer,
  stopTokenRefreshTimer,
  UserInfo,
} from '@/lib/auth-client';

interface AuthContextType {
  user: UserInfo | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    // The access token lives in memory and is gone after a reload — restore the
    // session from the httpOnly refresh cookie.
    bootstrapSession()
      .then((u) => {
        if (!mounted) return;
        if (u) {
          setUser(u);
          startTokenRefreshTimer();
        }
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    // Handle tab visibility changes - refresh token when user returns to tab
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && isAuthenticated()) {
        try {
          // getAccessToken will trigger refresh if needed
          const token = await getAccessToken();
          if (!token) {
            await oauthLogout();
            setUser(null);
            window.location.href = '/login';
          } else {
            startTokenRefreshTimer();
          }
        } catch {
          await oauthLogout();
          setUser(null);
          window.location.href = '/login';
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup on unmount
    return () => {
      mounted = false;
      stopTokenRefreshTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const login = async () => {
    await startAuthFlow();
  };

  const logout = async () => {
    await oauthLogout();
    setUser(null);
    window.location.href = '/';
  };

  const getToken = async () => {
    return getAccessToken();
  };

  const setUserFromCallback = (userInfo: UserInfo) => {
    setUser(userInfo);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoggedIn: !!user || isAuthenticated(),
        isLoading,
        login,
        logout,
        getToken,
      }}
    >
      <AuthContextInner setUser={setUserFromCallback}>{children}</AuthContextInner>
    </AuthContext.Provider>
  );
}

function AuthContextInner({
  children,
  setUser,
}: {
  children: ReactNode;
  setUser: (user: UserInfo) => void;
}) {
  return <SetUserContext.Provider value={setUser}>{children}</SetUserContext.Provider>;
}

const SetUserContext = createContext<(user: UserInfo) => void>(() => {});

export function useSetUser() {
  return useContext(SetUserContext);
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

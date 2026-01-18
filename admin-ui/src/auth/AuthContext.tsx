import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  isAuthenticated,
  getStoredUserInfo,
  getAccessToken,
  startAuthFlow,
  logout as oauthLogout,
  startTokenRefreshTimer,
  stopTokenRefreshTimer,
  UserInfo,
} from './oauth';

interface AuthContextType {
  user: UserInfo | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => void;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated()) {
      const storedUser = getStoredUserInfo();
      setUser(storedUser);
      // Start proactive token refresh timer
      startTokenRefreshTimer();
    }
    setIsLoading(false);

    // Handle tab visibility changes - refresh token when user returns to tab
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && isAuthenticated()) {
        console.log(`[Auth ${new Date().toISOString()}] Tab became visible, checking token`);
        try {
          // getAccessToken will trigger refresh if needed
          const token = await getAccessToken();
          if (!token) {
            console.log(`[Auth ${new Date().toISOString()}] No valid token after visibility check, logging out`);
            oauthLogout();
            setUser(null);
            window.location.href = '/login';
          } else {
            // Restart the timer in case it was throttled
            startTokenRefreshTimer();
          }
        } catch (err) {
          console.error(`[Auth ${new Date().toISOString()}] Token check failed on visibility change`, err);
          oauthLogout();
          setUser(null);
          window.location.href = '/login';
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup on unmount
    return () => {
      stopTokenRefreshTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const login = async () => {
    await startAuthFlow();
  };

  const logout = () => {
    oauthLogout();
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

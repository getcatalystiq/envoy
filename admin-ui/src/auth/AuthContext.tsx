import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  isAuthenticated,
  getStoredUserInfo,
  getAccessToken,
  startAuthFlow,
  logout as oauthLogout,
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
    }
    setIsLoading(false);
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
        isLoggedIn: isAuthenticated(),
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

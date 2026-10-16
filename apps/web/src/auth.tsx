import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type AdminProfile } from './api/client.js';

interface AuthContextValue {
  profile: AdminProfile | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setProfile(await api.me());
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const login = useCallback(
    async (email: string, password: string) => {
      await api.login(email, password);
      await refresh();
    },
    [refresh],
  );
  const logout = useCallback(async () => {
    if (profile) await api.logout(profile.csrf_token);
    setProfile(null);
  }, [profile]);
  const value = useMemo(
    () => ({ profile, loading, login, logout, refresh }),
    [profile, loading, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

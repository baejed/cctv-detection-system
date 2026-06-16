import {
  createContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { setToken, setUnauthorizedHandler } from '../services/api';
import { logout as apiLogout } from '../services/auth';
import { registerServiceWorkerAndSubscribe } from '../services/push';

interface AuthContextType {
  token: string | null;
  username: string | null;
  isAuthenticated: boolean;
  login: (token: string, username: string) => void;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>(null!);

const LS_TOKEN    = 'eyegila_token';
const LS_USERNAME = 'eyegila_username';

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(LS_TOKEN));
  const [username, setUsername] = useState<string | null>(() => localStorage.getItem(LS_USERNAME));

  // Sync the api module token on first mount (handles page refresh)
  useEffect(() => {
    if (token) setToken(token);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Evict session and redirect to login on any 401 from any API call
  useEffect(() => {
    setUnauthorizedHandler(() => {
      localStorage.removeItem(LS_TOKEN);
      localStorage.removeItem(LS_USERNAME);
      setTokenState(null);
      setUsername(null);
      setToken(null);
      toast.error('Session expired - please log in again');
      navigate('/login', { replace: true });
    });
  }, [navigate]);

  const login = useCallback((t: string, u: string) => {
    localStorage.setItem(LS_TOKEN, t);
    localStorage.setItem(LS_USERNAME, u);
    setTokenState(t);
    setUsername(u);
    setToken(t);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // silently ignore - server may already have cleared the session
    }
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USERNAME);
    setTokenState(null);
    setUsername(null);
    setToken(null);
  }, []);

  // Register service worker and push subscription after login
  useEffect(() => {
    if (token) {
      registerServiceWorkerAndSubscribe().catch(console.warn);
    }
  }, [token]);

  return (
    <AuthContext.Provider
      value={{ token, username, isAuthenticated: !!token, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

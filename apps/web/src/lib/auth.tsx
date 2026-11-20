import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasPermission, type Permission } from '@taskora/shared';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from './api';

export interface Me {
  user: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    timezone: string;
    isTechnician: boolean;
  };
  csrfToken: string;
  preferences: Record<string, unknown>;
  emailEnabled: boolean;
  organization: {
    name: string;
    currency: string;
    timezone: string;
    logoUpdatedAt?: string | null;
    /** Default UI language of the organization; a user's `preferences.language` overrides it. */
    language?: 'en' | 'fr' | 'nl' | 'de' | 'es';
    /** 'auto' (language default) or an explicit date pattern. */
    dateFormat?: 'auto' | 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd' | 'dd.MM.yyyy';
    /** Org default for opening tickets in their own window; `preferences.ticketOpenMode` overrides it. */
    ticketsOpenInWindow?: boolean;
  };
  /** Role grants every permission ('*'): may force-delete records that are still referenced. */
  superAdmin?: boolean;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: Permission) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api.get<Me>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], null);
    });
  }, [qc]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const me = query.data ?? null;
  const can = useCallback((perm: Permission) => !!me && hasPermission(me.user.permissions, perm), [me]);

  return <AuthContext.Provider value={{ me, loading: query.isLoading, can, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Signed-in user (only use inside authenticated routes). */
export function useMe() {
  const { me } = useAuth();
  if (!me) throw new Error('Not authenticated');
  return me;
}

export function Can({ perm, children, fallback = null }: { perm: Permission; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useAuth();
  return <>{can(perm) ? children : fallback}</>;
}

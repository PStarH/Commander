import { useState, useEffect, useCallback } from 'react';
import {
  fetchLogin,
  fetchRegister,
  fetchCurrentUser,
  getAuthToken,
  setAuthTokens,
  clearAuthToken,
  AUTH_CHANGE_EVENT,
  type AuthUser,
} from '../api';

/**
 * Manages user authentication state for the Commander web app.
 *
 * On mount, if a token is present in localStorage the hook validates it by
 * fetching the current user from `/api/auth/me`. If the token is invalid or
 * expired the credentials are cleared automatically.
 *
 * Listens for `AUTH_CHANGE_EVENT` (dispatched by the fetch interceptor on 401
 * or by login/logout calls) so the UI stays in sync across components.
 */
export function useAuth() {
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  // Only show a loading state when we actually have a token to validate.
  const [loading, setLoading] = useState<boolean>(() => getAuthToken() !== null);

  const isLoggedIn = token !== null && currentUser !== null;

  // Validate the token whenever it changes by fetching the current user.
  useEffect(() => {
    if (!token) {
      setCurrentUser(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchCurrentUser()
      .then(({ user }) => {
        if (!cancelled) {
          setCurrentUser(user);
        }
      })
      .catch(() => {
        // Token is invalid or expired — clear it so the login page shows.
        if (!cancelled) {
          clearAuthToken();
          setToken(null);
          setCurrentUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Stay in sync with auth changes originating outside this hook
  // (e.g. the 401 interceptor clearing the token, or another tab logging in).
  useEffect(() => {
    const handler = () => {
      setToken(getAuthToken());
    };
    window.addEventListener(AUTH_CHANGE_EVENT, handler);
    return () => window.removeEventListener(AUTH_CHANGE_EVENT, handler);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const response = await fetchLogin(username, password);
    setAuthTokens(response.token, response.refreshToken);
    setToken(response.token);
    setCurrentUser(response.user);
    return response;
  }, []);

  const register = useCallback(async (username: string, email: string, password: string) => {
    const response = await fetchRegister(username, email, password);
    setAuthTokens(response.token, response.refreshToken);
    setToken(response.token);
    setCurrentUser(response.user);
    return response;
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    setToken(null);
    setCurrentUser(null);
  }, []);

  return {
    token,
    currentUser,
    isLoggedIn,
    loading,
    login,
    register,
    logout,
  };
}

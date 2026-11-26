import { useState, useEffect } from 'react';
import { SessionStore, AuthSession, AuthUser } from '@/storage/sessionStore';

export interface UseSessionResult {
  session: AuthSession | null;
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoaded: boolean;
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<AuthSession | null>(SessionStore.getSession());
  const [isLoaded, setIsLoaded] = useState<boolean>(SessionStore.isInitialized());

  useEffect(() => {
    let isMounted = true;

    if (!SessionStore.isInitialized()) {
      SessionStore.initFromStorage()
        .then((s) => {
          if (isMounted) {
            setSession(s);
            setIsLoaded(true);
          }
        })
        .catch(() => {
          if (isMounted) {
            setIsLoaded(true);
          }
        });
    } else {
      setSession(SessionStore.getSession());
      setIsLoaded(true);
    }

    const unsubscribe = SessionStore.subscribe((newSession) => {
      if (isMounted) {
        setSession(newSession);
        setIsLoaded(true);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return {
    session,
    user: session?.user ?? null,
    token: session?.token ?? null,
    isAuthenticated: Boolean(session?.token && session?.user),
    isLoaded,
  };
}

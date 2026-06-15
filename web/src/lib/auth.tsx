"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import {
  bootstrap,
  login as apiLogin,
  logout as apiLogout,
  verifyMfa as apiVerifyMfa,
  type LoginResult,
  type User,
} from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bootstrap()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const result = await apiLogin(email, password);
    if (!result.mfaRequired) setUser(result.user);
    return result;
  };

  const verifyMfa = async (mfaToken: string, code: string) => {
    setUser(await apiVerifyMfa(mfaToken, code));
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, verifyMfa, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

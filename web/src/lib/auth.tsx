"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import {
  bootstrap,
  login as apiLogin,
  logout as apiLogout,
  startImpersonation as apiStartImpersonation,
  stopImpersonation as apiStopImpersonation,
  verifyMfa as apiVerifyMfa,
  type LoginResult,
  type User,
} from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  /** The target user when an impersonation session is active, else null. */
  impersonating: User | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  impersonate: (targetUserId: string) => Promise<void>;
  stopImpersonating: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [impersonating, setImpersonating] = useState<User | null>(null);

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
    setImpersonating(null);
    setUser(null);
  };

  const impersonate = async (targetUserId: string) => {
    const target = await apiStartImpersonation(targetUserId);
    setImpersonating(target);
    setUser(target);
  };

  const stopImpersonating = async () => {
    const admin = await apiStopImpersonation();
    setImpersonating(null);
    setUser(admin);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, impersonating, login, verifyMfa, logout, impersonate, stopImpersonating }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

import { createContext, useContext, useEffect, useState } from "react";
import api from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null = loading, false = unauthed, {} = authed
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const bootstrap = async () => {
      const token = localStorage.getItem("ledger_token");
      if (!token) {
        setUser(false);
        setChecked(true);
        return;
      }
      try {
        const { data } = await api.get("/auth/me");
        setUser(data);
      } catch (err) {
        // Interceptor tags expected bootstrap 401s with _silent — swallow without logging.
        if (!err?._silent) console.warn("Auth bootstrap failed:", err?.message);
        setUser(false);
      } finally {
        setChecked(true);
      }
    };
    bootstrap();

    // React to global session-expired events from the axios interceptor.
    const onUnauth = () => setUser(false);
    window.addEventListener("ledger:unauthorized", onUnauth);
    return () => window.removeEventListener("ledger:unauthorized", onUnauth);
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    if (data.access_token) localStorage.setItem("ledger_token", data.access_token);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    localStorage.removeItem("ledger_token");
    setUser(false);
  };

  return (
    <AuthContext.Provider value={{ user, checked, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

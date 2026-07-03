import axios from "axios";

export const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("ledger_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Global response interceptor — cleanly handle 401s (stale/expired token, or expected
// bootstrap failure) without letting them pollute the console as uncaught errors.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;
    const url = err?.config?.url || "";
    if (status === 401) {
      // Drop any stale token so subsequent requests don't retry with it.
      if (localStorage.getItem("ledger_token")) {
        localStorage.removeItem("ledger_token");
      }
      // Bootstrap /auth/me is expected to 401 for unauthenticated users — swallow silently.
      if (url.endsWith("/auth/me")) {
        return Promise.reject({ ...err, _silent: true });
      }
      // Any other 401 → user was logged in, session died. Notify app to redirect.
      if (typeof window !== "undefined" && !window.location.pathname.endsWith("/login")) {
        window.dispatchEvent(new CustomEvent("ledger:unauthorized"));
      }
    }
    return Promise.reject(err);
  }
);

export function formatCurrency(amount) {
  const n = Number(amount || 0);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

// Salutation: "Ramesh" → "Shree Ramesh Ji" (display-only; store raw in DB)
export function formatClientName(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return `Shree ${trimmed} Ji`;
}

export function formatDate(iso) {
  if (!iso) return "";
  // iso may be YYYY-MM-DD or full ISO datetime
  const dateOnly = iso.length >= 10 ? iso.slice(0, 10) : iso;
  const [y, m, d] = dateOnly.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

export function formatApiError(err) {
  const d = err?.response?.data?.detail;
  if (!d) return err?.message || "Something went wrong";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e?.msg || JSON.stringify(e)).join(", ");
  return String(d);
}

export default api;

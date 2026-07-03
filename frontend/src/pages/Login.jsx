import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Lock } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { formatApiError } from "@/lib/api";
import { toast } from "sonner";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@ledger.app");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      toast.success("Ledger unlocked");
      navigate("/", { replace: true });
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-[#f9f8f6]">
      {/* Left visual */}
      <div className="hidden lg:flex flex-col justify-between p-12 bg-[#292524] text-[#FAFAF9] relative overflow-hidden">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 border border-[#FAFAF9]/40 flex items-center justify-center">
            <BookOpen strokeWidth={1.5} className="w-5 h-5" />
          </div>
          <span className="font-serif text-2xl font-bold">Pankaj Purwar</span>
        </div>
        <div className="relative z-10">
          <h1 className="font-serif text-5xl xl:text-6xl leading-tight tracking-tight">
            A quiet place<br />
            <span className="italic text-stone-300">to keep your numbers</span>
          </h1>
          <p className="mt-8 max-w-md text-stone-400 leading-relaxed">
            Money in on the left. Money out on the right. Every entry immutable,
            every rupee accounted for — the way it was always meant to be.
          </p>
          <div className="mt-12 grid grid-cols-2 gap-8 border-t border-[#FAFAF9]/10 pt-8 max-w-md">
            <div>
              <div className="font-mono text-3xl">₹</div>
              <div className="text-xs uppercase tracking-widest text-stone-500 mt-1">In</div>
            </div>
            <div className="border-l border-[#FAFAF9]/10 pl-8">
              <div className="font-mono text-3xl">₹</div>
              <div className="text-xs uppercase tracking-widest text-stone-500 mt-1">Out</div>
            </div>
          </div>
        </div>
        <div className="text-xs text-stone-500 font-mono">
          — no cache, no leaks, encrypted at rest
        </div>
        {/* subtle diagonal lines */}
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: "repeating-linear-gradient(45deg, #FAFAF9, #FAFAF9 1px, transparent 1px, transparent 12px)"
        }} />
      </div>

      {/* Right form */}
      <div className="flex items-center justify-center p-6 sm:p-12">
        <form onSubmit={handleSubmit} className="w-full max-w-sm" data-testid="login-form">
          <div className="mb-10">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-stone-500 mb-4">
              <Lock strokeWidth={1.5} className="w-3.5 h-3.5" /> Secure entrance
            </div>
            <h2 className="font-serif text-4xl text-[#1C1917] tracking-tight">Sign in.</h2>
            <p className="text-stone-500 mt-2 text-sm">Only the accountant holds the key.</p>
          </div>          <div className="space-y-6">
            <div>
              <label className="text-xs uppercase tracking-widest text-stone-500">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="login-email-input"
                className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] px-0 py-2 text-lg font-mono focus:outline-none focus:border-[#292524] transition-colors"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-widest text-stone-500">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="login-password-input"
                className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] px-0 py-2 text-lg font-mono focus:outline-none focus:border-[#292524] transition-colors"
              />
            </div>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2" data-testid="login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              data-testid="login-submit-button"
              className="w-full bg-[#292524] text-[#FAFAF9] py-3 hover:bg-[#1C1917] transition-colors disabled:opacity-60 uppercase tracking-widest text-sm"
            >
              {loading ? "Opening…" : "Open Ledger"}
            </button>

            <div className="text-xs text-stone-400 text-center font-mono pt-4">
              default: admin@ledger.app / admin123
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

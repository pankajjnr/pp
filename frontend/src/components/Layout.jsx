import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { BookOpen, Users, LogOut, Languages, ClipboardList, ScrollText, Wheat, Wallet, Shield } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/context/LangContext";

function LiveClock({ lang }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const locale = lang === "hi" ? "hi-IN" : "en-IN";
  const dateStr = now.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeStr = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  return (
    <div className="flex flex-col items-end leading-tight" data-testid="live-clock">
      <span className="font-mono text-sm text-[#1C1917] tabular-nums" data-testid="clock-time">{timeStr}</span>
      <span className="text-[10px] uppercase tracking-widest text-stone-500" data-testid="clock-date">{dateStr}</span>
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { lang, toggle, t } = useLang();
  const navigate = useNavigate();

  const navItems = [
    { to: "/", label: t("nav.dailyLog"), icon: BookOpen, testid: "nav-dashboard" },
    { to: "/clients", label: t("nav.clients"), icon: Users, testid: "nav-clients" },
    { to: "/procurement/log", label: t("nav.procurementLog"), icon: ClipboardList, testid: "nav-procurement-log" },
    { to: "/procurement/client-subledger", label: t("nav.clientSubledger"), icon: ScrollText, testid: "nav-client-subledger" },
    { to: "/procurement/product-ledger", label: t("nav.productLedger"), icon: Wheat, testid: "nav-product-ledger" },
    { to: "/procurement/settlement", label: t("nav.settlement"), icon: Wallet, testid: "nav-settlement" },
  ];
  if (user?.role === "admin") {
    navItems.push({ to: "/admin/backup", label: "Backup", icon: Shield, testid: "nav-backup" });
  }

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#f9f8f6] paper-grain">
      <header className="border-b border-[#E7E5E4] bg-[#f9f8f6]/90 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
          <div className="flex items-center gap-6">
            <NavLink to="/" className="flex items-center gap-3" data-testid="brand-link">
              <div className="w-9 h-9 border border-[#292524] flex items-center justify-center">
                <BookOpen strokeWidth={1.5} className="w-5 h-5 text-[#292524]" />
              </div>
              <span className={`text-xl text-[#1C1917] tracking-tight font-bold ${lang === "hi" ? "" : "font-serif"}`}>
                {t("brand.name")}
              </span>
            </NavLink>
            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"} data-testid={n.testid}
                  className={({ isActive }) =>
                    `px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                      isActive ? "bg-[#292524] text-[#FAFAF9]" : "text-stone-700 hover:bg-[#F0EFEA]"
                    }`}
                >
                  <n.icon strokeWidth={1.5} className="w-4 h-4" />
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <LiveClock lang={lang} />
            <button onClick={toggle} data-testid="lang-toggle-btn" title="Toggle language"
              className="flex items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-widest border border-[#D6D3D1] hover:bg-[#F0EFEA] transition-colors">
              <Languages strokeWidth={1.5} className="w-4 h-4" />
              <span className="font-mono">{lang === "en" ? "EN" : "हिं"}</span>
            </button>
            <button onClick={handleLogout} data-testid="logout-btn"
              className="flex items-center gap-2 px-3 py-2 text-sm border border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA] transition-colors">
              <LogOut strokeWidth={1.5} className="w-4 h-4" />
              <span className="hidden sm:inline">{t("action.signOut")}</span>
            </button>
          </div>
        </div>
        <div className="md:hidden border-t border-[#E7E5E4] overflow-x-auto">
          <div className="flex px-4 gap-1 py-2 min-w-max">
            {navItems.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} data-testid={`${n.testid}-mobile`}
                className={({ isActive }) =>
                  `px-3 py-2 text-xs flex items-center gap-1 whitespace-nowrap ${
                    isActive ? "bg-[#292524] text-white" : "text-stone-700"
                  }`}>
                <n.icon strokeWidth={1.5} className="w-3.5 h-3.5" />
                {n.label}
              </NavLink>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-[#E7E5E4] mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 text-xs text-stone-500 flex justify-between">
          <span>{t("footer.immutable")}</span>
          <span className="font-mono">v2.0</span>
        </div>
      </footer>
    </div>
  );
}

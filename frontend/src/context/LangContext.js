import { createContext, useContext, useEffect, useState } from "react";
import { translations } from "@/lib/i18n";

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem("ledger_lang") || "en");

  useEffect(() => {
    localStorage.setItem("ledger_lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const t = (key) => (translations[lang] && translations[lang][key]) || translations.en[key] || key;

  const toggle = () => setLang((l) => (l === "en" ? "hi" : "en"));

  return (
    <LangContext.Provider value={{ lang, setLang, toggle, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within LangProvider");
  return ctx;
}

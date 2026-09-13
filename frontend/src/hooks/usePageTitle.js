import { useEffect } from "react";
import { useLang } from "@/context/LangContext";

/**
 * Set the browser tab title to "{page} — {brand}" for the current route.
 * Respects the current language via the shared i18n dictionary.
 */
export default function usePageTitle(labelOrKey, { isKey = false } = {}) {
  const { t, lang } = useLang();
  useEffect(() => {
    const brand = t("brand.name");
    const page = isKey ? t(labelOrKey) : labelOrKey;
    document.title = page ? `${page} — ${brand}` : brand;
  }, [labelOrKey, isKey, t, lang]);
}

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Calculator, TrendingUp, Package, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import EmptyState from "@/components/EmptyState";
import { useLang } from "@/context/LangContext";
import usePageTitle from "@/hooks/usePageTitle";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const ALL_PRODUCTS = { id: null, name: "__ALL__" };

export default function ProductLedger() {
  const { t } = useLang();
  usePageTitle("pl.title", { isKey: true });

  const today = new Date();
  const [products, setProducts] = useState([]);
  const [activeProduct, setActiveProduct] = useState(null);
  const [activeDate, setActiveDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [calMonth, setCalMonth] = useState(today);
  const [calOpen, setCalOpen] = useState(false);

  const [summary, setSummary] = useState(null);
  const [avgRate, setAvgRate] = useState(null);

  const activeDateIso = toIsoDate(activeDate);
  const isAllProducts = activeProduct && activeProduct.id === null;

  useEffect(() => {
    api.get("/procurement/products")
      .then((r) => {
        setProducts(r.data || []);
        if (r.data && r.data.length && !activeProduct) setActiveProduct(r.data[0]);
      })
      .catch((e) => toast.error(formatApiError(e)));
  }, []);

  useEffect(() => {
    if (!activeProduct) return;
    setLoading(true);
    setSummary(null);
    setAvgRate(null);
    const params = new URLSearchParams({ entry_date: activeDateIso });
    if (activeProduct.id) params.append("product_id", activeProduct.id);
    api.get(`/procurement/entries?${params.toString()}`)
      .then((r) => setRows(r.data || []))
      .catch((e) => toast.error(formatApiError(e)))
      .finally(() => setLoading(false));
  }, [activeProduct, activeDateIso]);

  const displayDate = useMemo(() => formatDate(activeDateIso), [activeDateIso]);
  const isToday = activeDateIso === toIsoDate(new Date());

  const productBreakdown = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.product_id || r.product_name;
      if (!map.has(key)) map.set(key, { product_id: key, product_name: r.product_name, weight: 0, cost: 0, count: 0 });
      const g = map.get(key);
      g.weight += Number(r.weight || 0);
      g.cost += Number(r.total_amount || 0);
      g.count += 1;
    }
    return [...map.values()].sort((a, b) => a.product_name.localeCompare(b.product_name));
  }, [rows]);

  const runSummary = () => {
    const totalWeight = rows.reduce((s, r) => s + Number(r.weight || 0), 0);
    const totalCost = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    setSummary({
      weight: +totalWeight.toFixed(2),
      cost: +totalCost.toFixed(2),
      count: rows.length,
    });
    setAvgRate(null);
  };

  const runWeightedAvg = () => {
    if (isAllProducts) {
      // Per-product weighted average (blended average across products is not meaningful)
      const perProduct = productBreakdown.map((p) => ({
        product_name: p.product_name,
        weight: +p.weight.toFixed(2),
        cost: +p.cost.toFixed(2),
        wavg: p.weight > 0 ? +(p.cost / p.weight).toFixed(4) : null,
      }));
      setAvgRate({ perProduct });
      return;
    }
    const totalWeight = rows.reduce((s, r) => s + Number(r.weight || 0), 0);
    const totalCost = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    if (totalWeight <= 0) {
      setAvgRate({ error: t("pl.wavgError") });
      return;
    }
    setAvgRate({
      value: +(totalCost / totalWeight).toFixed(4),
      totalWeight: +totalWeight.toFixed(2),
      totalCost: +totalCost.toFixed(2),
    });
  };

  return (
    <div className="space-y-8" data-testid="product-ledger-page">
      <header className="flex items-baseline justify-between border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">{t("proc.module")} 03</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="product-ledger-title">{t("pl.title")}</h1>
          <p className="text-sm text-stone-500 mt-1">{t("pl.subtitle")}</p>
        </div>
        <span className="font-mono text-xs uppercase tracking-widest text-stone-500" data-testid="active-context">
          {activeProduct
            ? (isAllProducts ? t("proc.allProducts") : activeProduct.name)
            : "—"} · {displayDate}{isToday ? ` (${t("pl.today")})` : ""}
        </span>
      </header>

      {/* Product buttons + calendar */}
      <div className="flex flex-wrap items-center gap-3" data-testid="product-toolbar">
        <div className="flex flex-wrap gap-2" data-testid="product-buttons">
          <button
            onClick={() => setActiveProduct(ALL_PRODUCTS)}
            data-testid="product-btn-all"
            className={cn(
              "px-4 py-2 text-sm uppercase tracking-widest border transition-colors flex items-center gap-2",
              isAllProducts
                ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
            )}>
            <LayoutGrid strokeWidth={1.5} className="w-3.5 h-3.5" />
            {t("proc.allProducts")}
          </button>
          {products.length === 0 && !isAllProducts && (
            <span className="text-xs text-stone-500 italic">{t("pl.noProducts")}</span>
          )}
          {products.map((p) => {
            const active = activeProduct && !isAllProducts && p.id === activeProduct.id;
            return (
              <button key={p.id} onClick={() => setActiveProduct(p)} data-testid={`product-btn-${p.id}`}
                className={cn(
                  "px-4 py-2 text-sm uppercase tracking-widest border transition-colors flex items-center gap-2",
                  active ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                         : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
                )}>
                <Package strokeWidth={1.5} className="w-3.5 h-3.5" />
                {p.name}
              </button>
            );
          })}
        </div>

        <div className="w-px h-8 bg-[#D6D3D1] mx-1 hidden sm:block" />

        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <button data-testid="product-date-trigger"
              className="flex items-center gap-2 border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]">
              <CalendarDays strokeWidth={1.5} className="w-4 h-4" />
              <span className="font-mono">{displayDate}</span>
              {isToday && <span className="text-[10px] uppercase tracking-widest text-stone-500 ml-1">{t("pl.today")}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 bg-white border-[#E7E5E4]" align="start">
            <Calendar mode="single" selected={activeDate}
              onSelect={(d) => { if (d) { setActiveDate(d); setCalOpen(false); } }}
              month={calMonth} onMonthChange={setCalMonth}
              disabled={{ after: new Date() }}
              toDate={new Date()}
              data-testid="product-calendar" />
          </PopoverContent>
        </Popover>

        <button onClick={() => setActiveDate(new Date())} data-testid="product-today-btn"
          className={cn(
            "px-3 py-2 text-xs uppercase tracking-widest border transition-colors",
            isToday ? "bg-[#F0EFEA] border-[#D6D3D1] text-stone-500 cursor-default"
                    : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
          )} disabled={isToday}>
          {t("pl.jumpToday")}
        </button>
      </div>

      {/* Data table */}
      <section className="bg-white border border-[#E7E5E4]" data-testid="product-table-section">
        <div className="px-5 py-3 border-b border-[#E7E5E4] bg-[#F5F4F0] flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold">
            {t("pl.entries")} — {isAllProducts ? t("proc.allProducts") : (activeProduct?.name || "—")} · <span className="font-mono">{displayDate}</span>
          </h2>
          <span className="text-xs text-stone-500 font-mono">{loading ? t("action.loading") : `${rows.length} ${t("sub.rows")}`}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="product-table">
            <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
              <tr>
                <th className="text-left px-5 py-3 font-medium">#</th>
                <th className="text-left px-5 py-3 font-medium">{t("proc.clientName")}</th>
                {isAllProducts && <th className="text-left px-5 py-3 font-medium">{t("proc.product")}</th>}
                <th className="text-right px-5 py-3 font-medium">{t("proc.weightQtl").replace("Weight", "Weight").replace("(Quintal)", `(${t("proc.qtl")})`)}</th>
                <th className="text-right px-5 py-3 font-medium">{t("proc.rate")} (₹/{t("proc.qtl")})</th>
                <th className="text-right px-5 py-3 font-medium">{t("proc.totalAmount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E5E4]">
              {rows.length === 0 && !loading ? (
                <tr><td colSpan={isAllProducts ? 6 : 5} className="p-0">
                  <EmptyState
                    icon={Package}
                    label={`${t("pl.noEntries")} ${isAllProducts ? t("proc.allProducts").toLowerCase() : (activeProduct?.name || "this product")} ${t("pl.on")} ${displayDate}.`}
                    testid="pl-empty" />
                </td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.id} className="hover:bg-[#FAFAF9]" data-testid={`product-row-${r.id}`}>
                  <td className="px-5 py-3 font-mono text-stone-400 text-[13px]">{String(i + 1).padStart(2, "0")}</td>
                  <td className="px-5 py-3">{formatClientName(r.client_name)}</td>
                  {isAllProducts && <td className="px-5 py-3">{r.product_name}</td>}
                  <td className="px-5 py-3 text-right font-mono">{r.weight.toLocaleString("en-IN")}</td>
                  <td className="px-5 py-3 text-right font-mono">{formatCurrency(r.rate)}</td>
                  <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(r.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Compute buttons */}
      <div className="flex flex-wrap items-center gap-3" data-testid="compute-toolbar">
        <button onClick={runSummary} disabled={rows.length === 0} data-testid="calc-summary-btn"
          className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-5 py-3 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          <Calculator strokeWidth={1.5} className="w-4 h-4" />
          {t("pl.calcSummary")}
        </button>
        <button onClick={runWeightedAvg} disabled={rows.length === 0} data-testid="calc-wavg-btn"
          className="inline-flex items-center gap-2 border border-[#292524] text-[#292524] px-5 py-3 text-sm uppercase tracking-widest hover:bg-[#292524] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[#292524] transition-colors">
          <TrendingUp strokeWidth={1.5} className="w-4 h-4" />
          {t("pl.calcWavg")}
        </button>
        {rows.length === 0 && (
          <span className="text-xs text-stone-500 italic">{t("pl.selectDate")}</span>
        )}
      </div>

      {/* Summary panel */}
      {summary && (
        <section className="bg-white border border-[#E7E5E4] p-6" data-testid="summary-panel">
          <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">
            {t("pl.summary")} · {isAllProducts ? t("proc.allProducts") : activeProduct?.name} · {displayDate}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-4">
            <Stat label={t("pl.totalWeight")} value={`${summary.weight.toLocaleString("en-IN")} ${t("proc.qtl").toLowerCase()}`} testid="summary-weight" />
            <Stat label={t("pl.totalCost")} value={formatCurrency(summary.cost)} testid="summary-cost" tone="positive" />
            <Stat label={t("pl.entriesCount")} value={String(summary.count)} testid="summary-count" mono />
          </div>
          {isAllProducts && productBreakdown.length > 1 && (
            <div className="mt-4 pt-4 border-t border-[#E7E5E4]">
              <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">{t("pl.perProductBreakdown")}</div>
              <table className="w-full text-sm" data-testid="pl-product-breakdown">
                <thead className="text-[11px] uppercase tracking-widest text-stone-500">
                  <tr>
                    <th className="text-left py-2 font-medium">{t("proc.product")}</th>
                    <th className="text-right py-2 font-medium">{t("proc.entries")}</th>
                    <th className="text-right py-2 font-medium">{t("proc.weight")} ({t("proc.qtl")})</th>
                    <th className="text-right py-2 font-medium">{t("proc.totalAmount")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {productBreakdown.map((p) => (
                    <tr key={p.product_id}>
                      <td className="py-2">{p.product_name}</td>
                      <td className="py-2 text-right font-mono">{p.count}</td>
                      <td className="py-2 text-right font-mono">{p.weight.toLocaleString("en-IN")}</td>
                      <td className="py-2 text-right font-mono font-semibold">{formatCurrency(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Weighted Avg panel */}
      {avgRate && (
        <section className="bg-white border border-[#E7E5E4] p-6" data-testid="wavg-panel">
          <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">
            {t("pl.wavgHeader")} · {isAllProducts ? t("proc.allProducts") : activeProduct?.name} · {displayDate}
          </div>
          {avgRate.error ? (
            <p className="text-[#9F1D1D] text-sm" data-testid="wavg-error">{avgRate.error}</p>
          ) : avgRate.perProduct ? (
            <div>
              <p className="text-xs text-stone-500 italic mb-3">{t("pl.combinedNote")}</p>
              <table className="w-full text-sm border border-[#E7E5E4]" data-testid="pl-wavg-per-product">
                <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">{t("proc.product")}</th>
                    <th className="text-right px-4 py-2 font-medium">{t("proc.weight")} ({t("proc.qtl")})</th>
                    <th className="text-right px-4 py-2 font-medium">{t("proc.total")}</th>
                    <th className="text-right px-4 py-2 font-medium">{t("pl.perProductWavg")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {avgRate.perProduct.map((p) => (
                    <tr key={p.product_name}>
                      <td className="px-4 py-2">{p.product_name}</td>
                      <td className="px-4 py-2 text-right font-mono">{p.weight.toLocaleString("en-IN")}</td>
                      <td className="px-4 py-2 text-right font-mono">{formatCurrency(p.cost)}</td>
                      <td className="px-4 py-2 text-right font-mono font-bold text-[#B45309]">
                        {p.wavg !== null ? `${formatCurrency(p.wavg)} / ${t("proc.qtl")}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-baseline gap-3 bg-[#FEF3C7] border border-[#B45309] px-5 py-4">
                <span className="font-serif text-4xl text-[#B45309] font-bold" data-testid="wavg-value">
                  {formatCurrency(avgRate.value)}
                </span>
                <span className="text-sm text-stone-500 font-mono">{t("pl.perQtl")}</span>
              </div>
              <div className="text-xs font-mono text-stone-500">
                = {formatCurrency(avgRate.totalCost)} ÷ {avgRate.totalWeight.toLocaleString("en-IN")} {t("proc.qtl").toLowerCase()}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, testid, mono, tone }) {
  const toneClass =
    tone === "positive" ? "text-[#B45309]" :
    tone === "negative" ? "text-[#9F1D1D]" :
    "text-[#1C1917]";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={cn("mt-1 text-3xl", mono ? "font-mono" : "font-serif", toneClass)} data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

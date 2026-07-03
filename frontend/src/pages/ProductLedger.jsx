import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Calculator, TrendingUp, Package } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * MODULE 3 — INTERACTIVE PRODUCT LEDGER
 * Product buttons + date picker (defaults to TODAY). Table shows filtered entries.
 * Summary + Weighted Average buttons compute on click (useState gated).
 */
export default function ProductLedger() {
  const today = new Date();
  const [products, setProducts] = useState([]);
  const [activeProduct, setActiveProduct] = useState(null); // {id, name}
  const [activeDate, setActiveDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [calMonth, setCalMonth] = useState(today);
  const [calOpen, setCalOpen] = useState(false);

  // Gated results — appear ONLY after respective button clicked
  const [summary, setSummary] = useState(null);   // { weight, cost }
  const [avgRate, setAvgRate] = useState(null);   // number | { error }

  const activeDateIso = toIsoDate(activeDate);

  // Load products master
  useEffect(() => {
    api.get("/procurement/products")
      .then((r) => {
        setProducts(r.data || []);
        if (r.data && r.data.length && !activeProduct) setActiveProduct(r.data[0]);
      })
      .catch((e) => toast.error(formatApiError(e)));
  }, []);

  // Fetch filtered rows whenever product OR date changes
  useEffect(() => {
    if (!activeProduct) return;
    setLoading(true);
    // Clear previous computed results — user must click again for fresh data
    setSummary(null);
    setAvgRate(null);
    const params = new URLSearchParams({
      product_id: activeProduct.id,
      entry_date: activeDateIso,
    });
    api.get(`/procurement/entries?${params.toString()}`)
      .then((r) => setRows(r.data || []))
      .catch((e) => toast.error(formatApiError(e)))
      .finally(() => setLoading(false));
  }, [activeProduct, activeDateIso]);

  const displayDate = useMemo(() => formatDate(activeDateIso), [activeDateIso]);
  const isToday = activeDateIso === toIsoDate(new Date());

  const runSummary = () => {
    const totalWeight = rows.reduce((s, r) => s + Number(r.weight || 0), 0);
    const totalCost = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    setSummary({
      weight: +totalWeight.toFixed(2),
      cost: +totalCost.toFixed(2),
      count: rows.length,
    });
    // Clear stale avg rate — user must recompute in current context
    setAvgRate(null);
  };

  const runWeightedAvg = () => {
    const totalWeight = rows.reduce((s, r) => s + Number(r.weight || 0), 0);
    const totalCost = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    if (totalWeight <= 0) {
      setAvgRate({ error: "No weight recorded on this date — average cannot be computed." });
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
      {/* Header */}
      <header className="flex items-baseline justify-between border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">Module 03</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="product-ledger-title">Product Ledger</h1>
          <p className="text-sm text-stone-500 mt-1">By grain, by day — audit any procurement history.</p>
        </div>
        <span className="font-mono text-xs uppercase tracking-widest text-stone-500" data-testid="active-context">
          {activeProduct ? activeProduct.name : "—"} · {displayDate}{isToday ? " (Today)" : ""}
        </span>
      </header>

      {/* Toolbar — product buttons + calendar */}
      <div className="flex flex-wrap items-center gap-3" data-testid="product-toolbar">
        <div className="flex flex-wrap gap-2" data-testid="product-buttons">
          {products.length === 0 && (
            <span className="text-xs text-stone-500 italic">No products in master list.</span>
          )}
          {products.map((p) => {
            const active = activeProduct && p.id === activeProduct.id;
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

        {/* Calendar picker */}
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <button data-testid="product-date-trigger"
              className="flex items-center gap-2 border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]">
              <CalendarDays strokeWidth={1.5} className="w-4 h-4" />
              <span className="font-mono">{displayDate}</span>
              {isToday && <span className="text-[10px] uppercase tracking-widest text-stone-500 ml-1">Today</span>}
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
          Jump to Today
        </button>
      </div>

      {/* Data table */}
      <section className="bg-white border border-[#E7E5E4]" data-testid="product-table-section">
        <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold">
            Entries — {activeProduct?.name || "—"} · <span className="font-mono">{displayDate}</span>
          </h2>
          <span className="text-xs text-stone-500 font-mono">{loading ? "Loading…" : `${rows.length} rows`}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="product-table">
            <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">#</th>
                <th className="text-left px-5 py-3 font-medium">Client Name</th>
                <th className="text-right px-5 py-3 font-medium">Weight (kg)</th>
                <th className="text-right px-5 py-3 font-medium">Rate (₹/kg)</th>
                <th className="text-right px-5 py-3 font-medium">Total Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E5E4]">
              {rows.length === 0 && !loading ? (
                <tr><td colSpan={5} className="text-center py-10 text-stone-500 italic">
                  No procurement of <span className="font-medium">{activeProduct?.name || "this product"}</span> on {displayDate}.
                </td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.id} className="hover:bg-[#FAFAF9]" data-testid={`product-row-${r.id}`}>
                  <td className="px-5 py-3 font-mono text-stone-400 text-[13px]">{String(i + 1).padStart(2, "0")}</td>
                  <td className="px-5 py-3">{formatClientName(r.client_name)}</td>
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
          className="inline-flex items-center gap-2 bg-[#292524] text-[#FAFAF9] px-5 py-3 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          <Calculator strokeWidth={1.5} className="w-4 h-4" />
          Calculate Summary
        </button>
        <button onClick={runWeightedAvg} disabled={rows.length === 0} data-testid="calc-wavg-btn"
          className="inline-flex items-center gap-2 border border-[#292524] text-[#292524] px-5 py-3 text-sm uppercase tracking-widest hover:bg-[#292524] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[#292524] transition-colors">
          <TrendingUp strokeWidth={1.5} className="w-4 h-4" />
          Weighted Avg Rate
        </button>
        {rows.length === 0 && (
          <span className="text-xs text-stone-500 italic">Select a date with entries to compute.</span>
        )}
      </div>

      {/* Summary panel — visible only after summary computed */}
      {summary && (
        <section className="bg-white border border-[#E7E5E4] p-6" data-testid="summary-panel">
          <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">
            Summary · {activeProduct?.name} · {displayDate}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <Stat label="Total Weight Bought" value={`${summary.weight.toLocaleString("en-IN")} kg`} testid="summary-weight" />
            <Stat label="Total Cost Spent" value={formatCurrency(summary.cost)} testid="summary-cost" />
            <Stat label="Entries" value={String(summary.count)} testid="summary-count" mono />
          </div>
        </section>
      )}

      {/* Weighted Avg panel — visible only after wavg computed */}
      {avgRate && (
        <section className="bg-white border border-[#E7E5E4] p-6" data-testid="wavg-panel">
          <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">
            Weighted Average Rate · {activeProduct?.name} · {displayDate}
          </div>
          {avgRate.error ? (
            <p className="text-orange-800 text-sm" data-testid="wavg-error">{avgRate.error}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-baseline gap-3">
                <span className="font-serif text-4xl text-[#1C1917]" data-testid="wavg-value">
                  {formatCurrency(avgRate.value)}
                </span>
                <span className="text-sm text-stone-500 font-mono">/ kg</span>
              </div>
              <div className="text-xs font-mono text-stone-500">
                = {formatCurrency(avgRate.totalCost)} (total cost) ÷ {avgRate.totalWeight.toLocaleString("en-IN")} kg (total weight)
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, testid, mono }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={cn("mt-1 text-3xl text-[#1C1917]", mono ? "font-mono" : "font-serif")} data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Boxes, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import api, { formatDate, formatApiError } from "@/lib/api";
import { useLang } from "@/context/LangContext";
import usePageTitle from "@/hooks/usePageTitle";
import EmptyState from "@/components/EmptyState";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const inputCls =
  "w-full bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524] placeholder:text-stone-400";
const smallBtn =
  "inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-40 transition-colors";

const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function balanceClass(b) {
  if (b < 0) return "text-red-700";
  if (b === 0) return "text-stone-500";
  return "text-emerald-700";
}

/**
 * STOCK BALANCE — per grain, in quintals.
 * Balance = bought (procurement) − sold (sales) + adjustments (opening stock,
 * wastage, corrections). Pick a grain to see every movement with a running balance.
 */
export default function Stock() {
  const { t } = useLang();
  usePageTitle("stock.title", { isKey: true });
  const [params, setParams] = useSearchParams();
  const grainId = params.get("grain") || "";

  const todayIso = toIsoDate(new Date());
  const [asOn, setAsOn] = useState(todayIso);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const [fromDate, setFromDate] = useState("");
  const [movements, setMovements] = useState(null);
  const [mvLoading, setMvLoading] = useState(false);

  // adjust-stock popup
  const [adjOpen, setAdjOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [adj, setAdj] = useState({ productId: "", direction: "add", qty: "", date: todayIso, note: "" });
  const [adjError, setAdjError] = useState("");
  const [adjSaving, setAdjSaving] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/stock/summary", { params: { as_on: asOn } });
      setSummary(r.data);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, [asOn]);

  const loadMovements = useCallback(async () => {
    if (!grainId) return;
    setMvLoading(true);
    try {
      const p = { product_id: grainId, as_on: asOn };
      if (fromDate) p.from_date = fromDate;
      const r = await api.get("/stock/movements", { params: p });
      setMovements(r.data);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setMvLoading(false);
    }
  }, [grainId, asOn, fromDate]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadMovements(); }, [loadMovements]);

  const openGrain = (id) => { setFromDate(""); setMovements(null); setParams({ grain: id }); };
  const closeGrain = () => { setFromDate(""); setMovements(null); setParams({}); };

  const openAdjust = () => {
    setAdj({ productId: grainId, direction: "add", qty: "", date: todayIso, note: "" });
    setAdjError("");
    setAdjOpen(true);
    api.get("/procurement/products").then((r) => setProducts(r.data || [])).catch(() => {});
  };

  const saveAdjust = async () => {
    const q = parseFloat(adj.qty);
    if (!adj.productId) { setAdjError(t("stock.err.grain")); return; }
    if (!q || q <= 0) { setAdjError(t("stock.err.qty")); return; }
    if (!adj.date || adj.date > todayIso) { setAdjError(t("stock.err.date")); return; }
    setAdjError("");
    setAdjSaving(true);
    try {
      await api.post("/stock/adjustments", {
        product_id: adj.productId,
        quantity: adj.direction === "remove" ? -q : q,
        date: adj.date,
        note: adj.note.trim() || null,
      });
      toast.success(t("stock.adjSaved"));
      setAdjOpen(false);
      await Promise.all([loadSummary(), loadMovements()]);
    } catch (err) {
      setAdjError(formatApiError(err)); // stay open so nothing typed is lost
    } finally {
      setAdjSaving(false);
    }
  };

  const deleteAdjust = async (row) => {
    if (!window.confirm(t("stock.confirmDelete"))) return;
    try {
      await api.delete(`/stock/adjustments/${row.id}`);
      toast.success(t("stock.adjDeleted"));
      await Promise.all([loadSummary(), loadMovements()]);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const asOnInput = (
    <label className="text-[11px] uppercase tracking-widest text-stone-500">
      {t("stock.asOn")}
      <input
        type="date" max={todayIso} value={asOn}
        onChange={(e) => { if (e.target.value) setAsOn(e.target.value); }}
        className={`${inputCls} w-40 ml-3 inline-block`} data-testid="stock-as-on"
      />
    </label>
  );

  const adjustDialog = (
    <Dialog open={adjOpen} onOpenChange={(open) => { if (!open && !adjSaving) setAdjOpen(false); }}>
      <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="stock-adjust-dialog">
        <DialogHeader>
          <DialogTitle className="text-2xl font-serif text-[#1C1917]">{t("stock.adjTitle")}</DialogTitle>
          <DialogDescription className="text-sm text-stone-600">{t("stock.adjDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block text-[11px] uppercase tracking-widest text-stone-500">
            {t("stock.adjGrain")}
            <select
              value={adj.productId} onChange={(e) => setAdj((a) => ({ ...a, productId: e.target.value }))}
              className={inputCls} data-testid="stock-adj-grain"
            >
              <option value="">{t("stock.selectGrain")}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="flex gap-6 text-sm">
            {["add", "remove"].map((d) => (
              <label key={d} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio" name="stock-dir" checked={adj.direction === d}
                  onChange={() => setAdj((a) => ({ ...a, direction: d }))} data-testid={`stock-adj-dir-${d}`}
                />
                {t(d === "add" ? "stock.adjAdd" : "stock.adjRemove")}
              </label>
            ))}
          </div>
          <label className="block text-[11px] uppercase tracking-widest text-stone-500">
            {t("stock.adjQty")}
            <input
              type="number" inputMode="decimal" min="0" step="any" value={adj.qty}
              onChange={(e) => setAdj((a) => ({ ...a, qty: e.target.value }))} className={inputCls} data-testid="stock-adj-qty"
            />
          </label>
          <label className="block text-[11px] uppercase tracking-widest text-stone-500">
            {t("stock.adjDate")}
            <input
              type="date" max={todayIso} value={adj.date}
              onChange={(e) => setAdj((a) => ({ ...a, date: e.target.value }))} className={inputCls} data-testid="stock-adj-date"
            />
          </label>
          <label className="block text-[11px] uppercase tracking-widest text-stone-500">
            {t("stock.adjNote")}
            <input
              type="text" maxLength={200} value={adj.note}
              onChange={(e) => setAdj((a) => ({ ...a, note: e.target.value }))} className={inputCls} data-testid="stock-adj-note"
            />
          </label>
        </div>
        {adjError && <p role="alert" className="text-sm text-red-700" data-testid="stock-adj-error">{adjError}</p>}
        <DialogFooter className="gap-2">
          <button type="button" onClick={() => setAdjOpen(false)} disabled={adjSaving} className={smallBtn} data-testid="stock-adj-cancel">
            {t("sales.cancelReview")}
          </button>
          <button
            type="button" onClick={saveAdjust} disabled={adjSaving} data-testid="stock-adj-save"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-4 py-2.5 text-xs uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-40 transition-colors"
          >
            {adjSaving ? t("sales.saving") : t("stock.adjSave")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // =====================================================================
  // VIEW 2 — movements of one grain
  // =====================================================================
  if (grainId) {
    const mv = movements;
    return (
      <div className="space-y-6" data-testid="stock-detail-page">
        <header className="border-b border-[#E7E5E4] pb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <button type="button" onClick={closeGrain} className="flex items-center gap-2 text-sm text-stone-600 hover:text-[#1C1917]" data-testid="stock-back">
              <ArrowLeft strokeWidth={1.5} className="w-4 h-4" />{t("stock.back")}
            </button>
            <h1 className="mt-3 text-3xl font-serif text-[#1C1917]" data-testid="stock-grain-name">{mv?.product_name || "…"}</h1>
          </div>
          <button type="button" onClick={openAdjust} className={smallBtn} data-testid="stock-adjust-btn">
            <Plus strokeWidth={1.5} className="w-4 h-4" />{t("stock.adjust")}
          </button>
        </header>

        <div className="flex flex-wrap items-end gap-6">
          <label className="text-[11px] uppercase tracking-widest text-stone-500">
            {t("stock.from")}
            <input
              type="date" max={asOn} value={fromDate || mv?.from_date || ""}
              onChange={(e) => setFromDate(e.target.value)} className={`${inputCls} w-40 ml-3 inline-block`} data-testid="stock-from"
            />
          </label>
          {asOnInput}
        </div>

        <div className="bg-white border border-[#E7E5E4] overflow-x-auto">
          {!mv || mvLoading ? (
            <p className="p-6 text-sm text-stone-500">…</p>
          ) : (
            <table className="w-full text-sm" data-testid="stock-movements-table">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                  <th className="px-3 py-3 font-medium">{t("stock.colDate")}</th>
                  <th className="px-3 py-3 font-medium">{t("stock.colType")}</th>
                  <th className="px-3 py-3 font-medium">{t("stock.colDetails")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("stock.colQty")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("stock.colBalance")}</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#F0EFEA] bg-[#FAFAF9]">
                  <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(mv.from_date)}</td>
                  <td className="px-3 py-3 text-xs font-semibold" colSpan={3}>{t("stock.opening")}</td>
                  <td className={`px-3 py-3 font-mono text-right font-medium ${balanceClass(mv.opening)}`}>{fmt(mv.opening)}</td>
                  <td />
                </tr>
                {mv.rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-stone-500">{t("stock.noMovements")}</td></tr>
                )}
                {mv.rows.map((r) => (
                  <tr key={`${r.type}-${r.id}`} className="border-b border-[#F0EFEA]" data-testid={`stock-row-${r.id}`}>
                    <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className="px-3 py-3 text-xs uppercase tracking-wide whitespace-nowrap">{t(`stock.type.${r.type}`)}</td>
                    <td className="px-3 py-3 text-stone-700">
                      {r.label}{r.extra ? <span className="text-stone-500"> · {r.extra}</span> : null}
                    </td>
                    <td className={`px-3 py-3 font-mono text-right ${r.qty < 0 ? "text-[#B45309]" : "text-emerald-700"}`}>
                      {r.qty > 0 ? "+" : ""}{fmt(r.qty)}
                    </td>
                    <td className={`px-3 py-3 font-mono text-right ${balanceClass(r.running)}`}>{fmt(r.running)}</td>
                    <td className="px-3 py-3 text-right">
                      {r.type === "adjust" && (
                        <button type="button" onClick={() => deleteAdjust(r)} aria-label={t("stock.adjDeleted")}
                          className="text-stone-400 hover:text-red-700" data-testid={`stock-del-${r.id}`}>
                          <Trash2 strokeWidth={1.5} className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[#E7E5E4] bg-[#FAFAF9] font-medium">
                  <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(mv.as_on)}</td>
                  <td className="px-3 py-3 text-xs uppercase tracking-widest" colSpan={3}>{t("stock.closing")}</td>
                  <td className={`px-3 py-3 font-mono text-right ${balanceClass(mv.closing)}`} data-testid="stock-closing">{fmt(mv.closing)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        {mv?.truncated && <p className="text-xs text-[#B45309]">{t("stock.truncated")}</p>}
        {adjustDialog}
      </div>
    );
  }

  // =====================================================================
  // VIEW 1 — all grains
  // =====================================================================
  const rows = summary?.rows || [];
  const totals = summary?.totals;
  return (
    <div className="space-y-6" data-testid="stock-page">
      <header className="border-b border-[#E7E5E4] pb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif text-[#1C1917]" data-testid="stock-title">{t("stock.title")}</h1>
          <p className="mt-1 text-sm text-stone-500">{t("stock.subtitle")}</p>
        </div>
        <button type="button" onClick={openAdjust} className={smallBtn} data-testid="stock-adjust-btn">
          <Plus strokeWidth={1.5} className="w-4 h-4" />{t("stock.adjust")}
        </button>
      </header>

      <div>{asOnInput}</div>

      <div className="bg-white border border-[#E7E5E4] overflow-x-auto">
        {loading && !summary ? (
          <p className="p-6 text-sm text-stone-500">…</p>
        ) : rows.length === 0 ? (
          <EmptyState icon={Boxes} label={t("stock.empty")} testid="stock-empty" />
        ) : (
          <table className="w-full text-sm" data-testid="stock-table">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                <th className="px-3 py-3 font-medium">{t("stock.colGrain")}</th>
                <th className="px-3 py-3 font-medium text-right">{t("stock.colBought")}</th>
                <th className="px-3 py-3 font-medium text-right">{t("stock.colSold")}</th>
                <th className="px-3 py-3 font-medium text-right">{t("stock.colAdjust")}</th>
                <th className="px-3 py-3 font-medium text-right">{t("stock.colBalance")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.product_id} onClick={() => openGrain(r.product_id)}
                  className="border-b border-[#F0EFEA] hover:bg-[#FAFAF9] cursor-pointer" data-testid={`stock-row-${r.product_id}`}
                >
                  <td className="px-3 py-3">
                    <button type="button" onClick={() => openGrain(r.product_id)} className="font-medium text-[#1C1917] text-left hover:underline">
                      {r.product_name}
                    </button>
                    {r.balance < 0 && <div className="text-[11px] text-red-700">{t("stock.negativeNote")}</div>}
                  </td>
                  <td className="px-3 py-3 font-mono text-right">{fmt(r.bought)}</td>
                  <td className="px-3 py-3 font-mono text-right">{fmt(r.sold)}</td>
                  <td className="px-3 py-3 font-mono text-right">{r.adjusted > 0 ? "+" : ""}{fmt(r.adjusted)}</td>
                  <td className={`px-3 py-3 font-mono text-right font-medium ${balanceClass(r.balance)}`}>{fmt(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t border-[#E7E5E4] bg-[#FAFAF9] font-medium">
                  <td className="px-3 py-3 text-xs uppercase tracking-widest">{t("stock.total")}</td>
                  <td className="px-3 py-3 font-mono text-right">{fmt(totals.bought)}</td>
                  <td className="px-3 py-3 font-mono text-right">{fmt(totals.sold)}</td>
                  <td className="px-3 py-3 font-mono text-right">{totals.adjusted > 0 ? "+" : ""}{fmt(totals.adjusted)}</td>
                  <td className={`px-3 py-3 font-mono text-right ${balanceClass(totals.balance)}`} data-testid="stock-total-balance">{fmt(totals.balance)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
      <p className="text-xs text-stone-500">{t("stock.footnote")}</p>
      {adjustDialog}
    </div>
  );
}

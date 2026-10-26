import { useCallback, useEffect, useState } from "react";
import { AlertCircle, BarChart3, LockKeyhole, RefreshCw, TrendingUp, Wheat, Wallet } from "lucide-react";
import { toast } from "sonner";
import api, { formatApiError, formatCurrency } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import usePageTitle from "@/hooks/usePageTitle";

const fmtQty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function SummaryCard({ label, value, detail, icon: Icon, tone = "stone" }) {
  const tones = {
    stone: "border-stone-200 bg-white text-stone-900",
    green: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
    amber: "border-amber-200 bg-amber-50/70 text-amber-900",
    blue: "border-sky-200 bg-sky-50/70 text-sky-900",
  };
  return (
    <div className={`border p-5 ${tones[tone] || tones.stone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest opacity-70">{label}</p>
          <p className="mt-3 font-mono text-2xl sm:text-3xl font-semibold break-words">{value}</p>
          {detail && <p className="mt-2 text-xs opacity-70">{detail}</p>}
        </div>
        {Icon && <Icon className="w-5 h-5 opacity-70 shrink-0" strokeWidth={1.5} />}
      </div>
    </div>
  );
}

export default function OwnerProfit() {
  usePageTitle("Owner Profit & Accounts");
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadSummary = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    try {
      const response = await api.get("/owner/profit-summary");
      setSummary(response.data);
    } catch (error) {
      toast.error(formatApiError(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  if (user?.role !== "admin") {
    return (
      <div className="max-w-xl mx-auto py-20 text-center" data-testid="owner-profit-forbidden">
        <LockKeyhole className="w-10 h-10 mx-auto text-stone-400 mb-4" strokeWidth={1.5} />
        <h1 className="font-serif text-2xl text-stone-900">Owner access only</h1>
        <p className="mt-2 text-sm text-stone-500">This financial dashboard is available only to the owner/admin account.</p>
      </div>
    );
  }

  const totals = summary?.totals || {};
  const rows = summary?.rows || [];

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-7" data-testid="owner-profit-page">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-[#E7E5E4] pb-5">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-amber-700 mb-2">
            <LockKeyhole className="w-4 h-4" strokeWidth={1.5} /> Owner-only financials
          </div>
          <h1 className="font-serif text-3xl sm:text-4xl text-[#1C1917]">Owner Profit & Accounts</h1>
          <p className="text-sm text-stone-500 mt-2">Crop-wise overview calculated from recorded procurement, sales, and stock adjustments.</p>
        </div>
        <button type="button" onClick={() => loadSummary(true)} disabled={refreshing || loading}
          className="inline-flex items-center justify-center gap-2 border border-[#D6D3D1] px-4 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh figures
        </button>
      </header>

      {summary?.notes?.length > 0 && (
        <div className="border border-amber-200 bg-amber-50/70 p-4 space-y-2" data-testid="profit-calculation-notes">
          {summary.notes.map((note) => (
            <p key={note} className="flex items-start gap-2 text-sm text-amber-950">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.7} /> {note}
            </p>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-stone-500">Calculating crop-wise figures…</div>
      ) : (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-label="Profit summary">
            <SummaryCard label="Sales revenue" value={formatCurrency(totals.sales_revenue)} detail={`${fmtQty(totals.sold_quantity)} quintals sold`} icon={TrendingUp} tone="blue" />
            <SummaryCard label="Cost of goods sold" value={formatCurrency(totals.cost_of_goods_sold)} detail="Weighted-average purchase cost" icon={Wheat} />
            <SummaryCard label="Gross profit" value={formatCurrency(totals.gross_profit)} detail="Before expenses" icon={BarChart3} tone="green" />
            <SummaryCard label="Net profit so far" value={formatCurrency(totals.net_profit)} detail="Expenses not deducted yet" icon={Wallet} tone="amber" />
          </section>

          <section className="border border-[#E7E5E4] bg-white">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-5 py-4 border-b border-[#E7E5E4]">
              <div>
                <h2 className="font-serif text-2xl text-[#1C1917]">Crop-wise profit</h2>
                <p className="text-xs text-stone-500 mt-1">All recorded history · quantities are in quintals</p>
              </div>
              <span className="text-xs uppercase tracking-widest text-stone-500">{rows.length} products</span>
            </div>
            {rows.length === 0 ? (
              <div className="py-14 text-center text-sm text-stone-500">No product or transaction records found yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1050px] text-sm">
                  <thead className="bg-[#F9F8F6] text-[10px] uppercase tracking-widest text-stone-500">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Crop</th>
                      <th className="text-right px-4 py-3 font-medium">Purchased (qtl)</th>
                      <th className="text-right px-4 py-3 font-medium">Avg. purchase rate</th>
                      <th className="text-right px-4 py-3 font-medium">Sold (qtl)</th>
                      <th className="text-right px-4 py-3 font-medium">Sales revenue</th>
                      <th className="text-right px-4 py-3 font-medium">Cost of sold stock</th>
                      <th className="text-right px-4 py-3 font-medium">Gross profit</th>
                      <th className="text-right px-4 py-3 font-medium">Remaining (qtl)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E7E5E4]">
                    {rows.map((row) => (
                      <tr key={row.product_id} className="hover:bg-[#FAFAF9]">
                        <td className="px-4 py-3 font-medium text-[#1C1917]">{row.product_name}</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtQty(row.purchased_quantity)}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatCurrency(row.average_purchase_rate)}</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtQty(row.sold_quantity)}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatCurrency(row.sales_revenue)}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatCurrency(row.cost_of_goods_sold)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-semibold ${row.gross_profit < 0 ? "text-red-700" : "text-emerald-800"}`}>{formatCurrency(row.gross_profit)}</td>
                        <td className={`px-4 py-3 text-right font-mono ${row.remaining_stock < 0 ? "text-red-700" : "text-stone-700"}`}>{fmtQty(row.remaining_stock)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-[#F9F8F6] border-t border-[#D6D3D1] font-semibold">
                    <tr>
                      <td className="px-4 py-3">TOTAL</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtQty(totals.purchased_quantity)}</td>
                      <td className="px-4 py-3 text-right">—</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtQty(totals.sold_quantity)}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatCurrency(totals.sales_revenue)}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatCurrency(totals.cost_of_goods_sold)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-800">{formatCurrency(totals.gross_profit)}</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtQty(totals.remaining_stock)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <section className="border border-dashed border-[#D6D3D1] bg-[#F9F8F6] p-5 sm:p-6" data-testid="expenses-placeholder">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 border border-[#D6D3D1] bg-white flex items-center justify-center shrink-0">
                <Wallet className="w-5 h-5 text-stone-500" strokeWidth={1.5} />
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-serif text-2xl text-[#1C1917]">Expenses</h2>
                  <span className="px-2 py-1 text-[10px] uppercase tracking-widest border border-stone-300 text-stone-500">Coming later</span>
                </div>
                <p className="text-sm text-stone-600 mt-2 max-w-3xl">This section is reserved for future expense entry and allocation. No expense values are currently assumed or deducted from the profit shown above.</p>
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

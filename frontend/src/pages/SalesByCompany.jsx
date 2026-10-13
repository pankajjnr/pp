import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Building2, ArrowLeft, Download, FileText, Plus, Trash2, Search, Check, Undo2,
} from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError } from "@/lib/api";
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

// Indian financial year starts 1 April.
function fyStartIso(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

const inputCls =
  "w-full bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524] placeholder:text-stone-400";
const smallBtn =
  "inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-40 transition-colors";

const MODES = ["cash", "bank", "upi", "cheque", "other"];

function balanceClass(b) {
  if (b > 0) return "text-[#B45309]";
  if (b < 0) return "text-emerald-700";
  return "text-stone-500";
}

/**
 * SALES BY COMPANY — all companies with what they owe, and per-company
 * statements: every sale (date, bill, truck, driver…), payments received,
 * running balance, product-wise totals, PDF/CSV download.
 * Balance = total sold − payments received (positive = due from the company).
 */
export default function SalesByCompany() {
  const { t } = useLang();
  usePageTitle("sc.title", { isKey: true });
  const [params, setParams] = useSearchParams();
  const company = params.get("company") || "";

  const todayIso = toIsoDate(new Date());
  const defaultFilters = useMemo(
    () => ({ from: fyStartIso(), to: todayIso, productId: "" }),
    [todayIso]
  );

  const [companies, setCompanies] = useState([]);
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(false);

  // payment popup
  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState({ date: todayIso, amount: "", mode: "cash", note: "" });
  const [payError, setPayError] = useState("");
  const [paySaving, setPaySaving] = useState(false);

  // truck settlement popup
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleRow, setSettleRow] = useState(null);
  const [settle, setSettle] = useState({ date: todayIso, cut: "", paid: "" });
  const [settleError, setSettleError] = useState("");
  const [settleSaving, setSettleSaving] = useState(false);

  const loadCompanies = useCallback(async () => {
    try {
      const r = await api.get("/sales/companies");
      setCompanies(r.data || []);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }, []);

  const loadStatement = useCallback(async () => {
    if (!company) return;
    setLoading(true);
    try {
      const p = { buyer_name: company };
      if (filters.from) p.from_date = filters.from;
      if (filters.to) p.to_date = filters.to;
      if (filters.productId) p.product_id = filters.productId;
      const r = await api.get("/sales/companies/statement", { params: p });
      setStatement(r.data);
    } catch (err) {
      setStatement(null);
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, [company, filters]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);
  useEffect(() => {
    api.get("/procurement/products")
      .then((r) => setProducts(r.data || []))
      .catch(() => { /* filter just stays empty */ });
  }, []);
  useEffect(() => { loadStatement(); }, [loadStatement]);

  const openCompany = (name) => {
    setFilters(defaultFilters);
    setStatement(null);
    setParams({ company: name });
  };
  const backToList = () => {
    setStatement(null);
    setParams({});
    loadCompanies();
  };

  const visibleCompanies = useMemo(() => {
    const q = search.trim().toUpperCase();
    return q ? companies.filter((c) => c.buyer_name.includes(q)) : companies;
  }, [companies, search]);

  const netDue = useMemo(() => companies.reduce((a, c) => a + c.balance, 0), [companies]);

  const balanceText = (b) =>
    `${formatCurrency(Math.abs(b))}${b > 0 ? ` ${t("sc.due")}` : b < 0 ? ` ${t("sc.advance")}` : ""}`;

  // ---------- downloads ----------
  const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadStatement = async (fmt) => {
    try {
      const p = { buyer_name: company, file_format: fmt };
      if (filters.from) p.from_date = filters.from;
      if (filters.to) p.to_date = filters.to;
      if (filters.productId) p.product_id = filters.productId;
      const res = await api.get("/sales/companies/statement/export", { params: p, responseType: "blob" });
      saveBlob(res.data, `sales_${company.replace(/[^A-Za-z0-9]+/g, "_")}.${fmt}`);
      toast.success(t("sc.downloaded"));
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const downloadBill = async (row) => {
    try {
      const res = await api.get(`/sales/${row.id}/bill`, { responseType: "blob" });
      saveBlob(res.data, `bill_${(row.bill_no || row.id.slice(0, 8)).replace(/\//g, "-")}.pdf`);
      toast.success(t("sales.billDownloaded"));
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // ---------- payments ----------
  const openPay = () => {
    setPay({ date: todayIso, amount: "", mode: "cash", note: "" });
    setPayError("");
    setPayOpen(true);
  };

  const savePayment = async () => {
    if (!(parseFloat(pay.amount) > 0)) { setPayError(t("sc.err.amount")); return; }
    if (!pay.date || pay.date > todayIso) { setPayError(t("sales.err.date")); return; }
    setPayError("");
    setPaySaving(true);
    try {
      await api.post("/sales/payments", {
        buyer_name: company,
        amount: parseFloat(pay.amount),
        payment_date: pay.date,
        mode: pay.mode,
        note: pay.note.trim() || null,
      });
      toast.success(t("sc.paymentSaved"));
      setPayOpen(false);
      await Promise.all([loadStatement(), loadCompanies()]);
    } catch (err) {
      setPayError(formatApiError(err)); // stay in the popup so nothing typed is lost
    } finally {
      setPaySaving(false);
    }
  };

  const deletePayment = async (row) => {
    if (!window.confirm(t("sc.confirmDeletePayment"))) return;
    try {
      await api.delete(`/sales/payments/${row.id}`);
      toast.success(t("sc.paymentDeleted"));
      await Promise.all([loadStatement(), loadCompanies()]);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // ---------- truck settlement ----------
  const round2 = (n) => Math.round(n * 100) / 100;
  const unassigned = Math.max(statement?.summary?.unassigned || 0, 0);

  const openSettle = (row) => {
    const paid = Math.max(0, Math.min(row.due, unassigned));
    setSettleRow(row);
    setSettle({ date: todayIso, cut: "", paid: paid ? String(round2(paid)) : "" });
    setSettleError("");
    setSettleOpen(true);
  };

  // typing the cut re-fills "paid" = truck due − cut (limited to money available)
  const changeCut = (value) => {
    const cut = parseFloat(value) || 0;
    const paid = Math.max(0, Math.min((settleRow?.due || 0) - cut, unassigned));
    setSettle((s) => ({ ...s, cut: value, paid: paid ? String(round2(paid)) : "" }));
  };

  const saveSettle = async () => {
    const paid = parseFloat(settle.paid) || 0;
    const cut = parseFloat(settle.cut) || 0;
    if (paid + cut <= 0) { setSettleError(t("sc.settleNeed")); return; }
    if (!settle.date || settle.date > todayIso) { setSettleError(t("sales.err.date")); return; }
    setSettleError("");
    setSettleSaving(true);
    try {
      await api.post("/sales/settlements", { sale_id: settleRow.id, paid, cut, date: settle.date });
      toast.success(t("sc.settleSaved"));
      setSettleOpen(false);
      await Promise.all([loadStatement(), loadCompanies()]);
    } catch (err) {
      setSettleError(formatApiError(err)); // stay open so nothing typed is lost
    } finally {
      setSettleSaving(false);
    }
  };

  const undoSettle = async (row) => {
    if (!window.confirm(t("sc.confirmUndo"))) return;
    try {
      await api.delete(`/sales/settlements/by-sale/${row.id}`);
      toast.success(t("sc.undone"));
      await Promise.all([loadStatement(), loadCompanies()]);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const autoSettle = async () => {
    try {
      const r = await api.post("/sales/companies/auto-settle", { buyer_name: company });
      toast.success(`${t("sc.autoDone")} ${r.data.trucks}`);
      await Promise.all([loadStatement(), loadCompanies()]);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // =====================================================================
  // VIEW 1 — all companies
  // =====================================================================
  if (!company) {
    return (
      <div className="space-y-6" data-testid="sales-companies-page">
        <header className="border-b border-[#E7E5E4] pb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-serif text-[#1C1917]" data-testid="sc-title">{t("sc.title")}</h1>
            <p className="mt-1 text-sm text-stone-500">{t("sc.subtitle")}</p>
          </div>
          <Link to="/sales" className={smallBtn} data-testid="sc-to-sales">
            <ArrowLeft strokeWidth={1.5} className="w-4 h-4" />
            {t("nav.sales")}
          </Link>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="flex items-center gap-2 border-b border-[#D6D3D1] w-full sm:w-80">
            <Search strokeWidth={1.5} className="w-4 h-4 text-stone-400" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sc.search")} data-testid="sc-search"
              className="flex-1 bg-transparent py-2 text-sm focus:outline-none placeholder:text-stone-400"
            />
          </label>
          <div className="text-sm text-stone-600" data-testid="sc-net-due">
            {t("sc.totalDue")}:{" "}
            <span className={`font-mono text-lg ${balanceClass(netDue)}`}>{balanceText(netDue)}</span>
          </div>
        </div>

        <div className="bg-white border border-[#E7E5E4] overflow-x-auto">
          {visibleCompanies.length === 0 ? (
            <EmptyState icon={Building2} label={t("sc.noCompanies")} testid="sc-empty" />
          ) : (
            <table className="w-full text-sm" data-testid="sc-companies-table">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                  <th className="px-3 py-3 font-medium">{t("sc.colCompany")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("sc.colTrucks")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("sales.colQty")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("sc.colSold")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("sc.colReceived")}</th>
                  <th className="px-3 py-3 font-medium text-right">{t("sc.colBalance")}</th>
                  <th className="px-3 py-3 font-medium">{t("sc.colLast")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleCompanies.map((c) => (
                  <tr
                    key={c.buyer_name} onClick={() => openCompany(c.buyer_name)}
                    className="border-b border-[#F0EFEA] hover:bg-[#FAFAF9] cursor-pointer"
                    data-testid={`sc-company-row-${c.buyer_name}`}
                  >
                    <td className="px-3 py-3">
                      <button type="button" onClick={() => openCompany(c.buyer_name)} className="font-medium text-[#1C1917] text-left hover:underline">
                        {c.buyer_name}
                      </button>
                    </td>
                    <td className="px-3 py-3 font-mono text-right">{c.trucks}</td>
                    <td className="px-3 py-3 font-mono text-right">{c.total_quantity.toLocaleString("en-IN")}</td>
                    <td className="px-3 py-3 font-mono text-right">{formatCurrency(c.total_amount)}</td>
                    <td className="px-3 py-3 font-mono text-right">{formatCurrency(c.total_paid)}</td>
                    <td className={`px-3 py-3 font-mono text-right font-medium ${balanceClass(c.balance)}`}>{balanceText(c.balance)}</td>
                    <td className="px-3 py-3 font-mono whitespace-nowrap text-stone-600">{c.last_sale_date ? formatDate(c.last_sale_date) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  // =====================================================================
  // VIEW 2 — one company's statement
  // =====================================================================
  const totals = statement?.totals;
  const withPayments = statement?.with_payments;

  return (
    <div className="space-y-6" data-testid="sales-statement-page">
      <header className="border-b border-[#E7E5E4] pb-4">
        <button type="button" onClick={backToList} className={smallBtn} data-testid="sc-back">
          <ArrowLeft strokeWidth={1.5} className="w-4 h-4" />
          {t("sc.back")}
        </button>
        <h1 className="mt-4 text-3xl font-serif text-[#1C1917]" data-testid="sc-company-name">{company}</h1>
      </header>

      {/* filters + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[11px] uppercase tracking-widest text-stone-500">
            {t("sc.from")}
            <input
              type="date" value={filters.from} max={filters.to || todayIso}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
              data-testid="sc-from"
              className="mt-1 block bg-transparent border-b border-[#D6D3D1] py-1.5 font-mono text-sm normal-case tracking-normal text-[#1C1917] focus:outline-none focus:border-[#292524]"
            />
          </label>
          <label className="text-[11px] uppercase tracking-widest text-stone-500">
            {t("sc.to")}
            <input
              type="date" value={filters.to} min={filters.from || undefined} max={todayIso}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
              data-testid="sc-to"
              className="mt-1 block bg-transparent border-b border-[#D6D3D1] py-1.5 font-mono text-sm normal-case tracking-normal text-[#1C1917] focus:outline-none focus:border-[#292524]"
            />
          </label>
          <label className="text-[11px] uppercase tracking-widest text-stone-500">
            {t("sc.product")}
            <select
              value={filters.productId}
              onChange={(e) => setFilters((f) => ({ ...f, productId: e.target.value }))}
              data-testid="sc-product"
              className="mt-1 block bg-transparent border-b border-[#D6D3D1] py-1.5 text-sm normal-case tracking-normal text-[#1C1917] focus:outline-none focus:border-[#292524]"
            >
              <option value="">{t("sc.allProducts")}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button type="button" className={smallBtn} data-testid="sc-fy"
            onClick={() => setFilters((f) => ({ ...f, from: fyStartIso(), to: todayIso }))}>
            {t("sc.thisFy")}
          </button>
          <button type="button" className={smallBtn} data-testid="sc-all-time"
            onClick={() => setFilters((f) => ({ ...f, from: "", to: "" }))}>
            {t("sc.allTime")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button" onClick={openPay} data-testid="sc-add-payment"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-4 py-2.5 text-xs uppercase tracking-widest hover:bg-[#92400E] transition-colors"
          >
            <Plus strokeWidth={1.5} className="w-4 h-4" />
            {t("sc.addPayment")}
          </button>
          <button type="button" onClick={() => downloadStatement("pdf")} className={smallBtn} data-testid="sc-pdf">
            <Download strokeWidth={1.5} className="w-4 h-4" />{t("sc.pdf")}
          </button>
          <button type="button" onClick={() => downloadStatement("csv")} className={smallBtn} data-testid="sc-csv">
            <Download strokeWidth={1.5} className="w-4 h-4" />{t("sc.csv")}
          </button>
        </div>
      </div>

      {statement && (
        <>
          {/* summary cards */}
          <div className={`grid grid-cols-2 ${withPayments ? "md:grid-cols-5" : "md:grid-cols-2"} gap-px bg-[#E7E5E4] border border-[#E7E5E4]`}>
            <div className="bg-white px-4 py-3" data-testid="sc-card-sold">
              <div className="text-[10px] uppercase tracking-widest text-stone-500">{t("sc.totalSold")}</div>
              <div className="mt-1 font-mono text-lg text-[#1C1917]">{formatCurrency(totals.sales_amount)}</div>
            </div>
            <div className="bg-white px-4 py-3" data-testid="sc-card-trucks">
              <div className="text-[10px] uppercase tracking-widest text-stone-500">{t("sc.trucksQty")}</div>
              <div className="mt-1 font-mono text-lg text-[#1C1917]">
                {totals.trucks} / {totals.quantity.toLocaleString("en-IN")} Qtl
              </div>
            </div>
            {withPayments && (
              <>
                <div className="bg-white px-4 py-3" data-testid="sc-card-received">
                  <div className="text-[10px] uppercase tracking-widest text-stone-500">{t("sc.received")}</div>
                  <div className="mt-1 font-mono text-lg text-emerald-700">{formatCurrency(totals.payments_total)}</div>
                </div>
                <div className="bg-white px-4 py-3" data-testid="sc-card-cuts">
                  <div className="text-[10px] uppercase tracking-widest text-stone-500">{t("sc.cuts")}</div>
                  <div className="mt-1 font-mono text-lg text-[#B45309]">{formatCurrency(totals.cuts_total)}</div>
                </div>
                <div className="bg-white px-4 py-3" data-testid="sc-card-balance">
                  <div className="text-[10px] uppercase tracking-widest text-stone-500">{t("sc.balanceDue")}</div>
                  <div className={`mt-1 font-mono text-lg ${balanceClass(totals.closing_balance)}`}>
                    {balanceText(totals.closing_balance)}
                  </div>
                </div>
              </>
            )}
          </div>
          {!withPayments && <p className="text-xs text-stone-500">{t("sc.productFilterNote")}</p>}

          {/* received money still waiting to be assigned to trucks */}
          {unassigned > 0.01 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-emerald-200 bg-emerald-50/60 px-4 py-3" data-testid="sc-unassigned">
              <div className="text-sm text-stone-700">
                {t("sc.notAssigned")}:{" "}
                <span className="font-mono text-lg text-emerald-700">{formatCurrency(unassigned)}</span>
              </div>
              <button type="button" onClick={autoSettle} data-testid="sc-auto-settle" className={smallBtn}>
                <Check strokeWidth={1.5} className="w-4 h-4" />{t("sc.autoSettle")}
              </button>
            </div>
          )}

          {/* statement table */}
          <div className="bg-white border border-[#E7E5E4] overflow-x-auto">
            {statement.rows.length === 0 ? (
              <EmptyState icon={Building2} label={t("sc.noRows")} testid="sc-no-rows" />
            ) : (
              <table className="w-full text-sm" data-testid="sc-statement-table">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                    <th className="px-3 py-3 font-medium">{t("sales.colDate")}</th>
                    <th className="px-3 py-3 font-medium">{t("sales.colBill")}</th>
                    <th className="px-3 py-3 font-medium">{t("sales.colProduct")}</th>
                    <th className="px-3 py-3 font-medium text-right">{t("sales.colQty")}</th>
                    <th className="px-3 py-3 font-medium text-right">{t("sales.colRate")}</th>
                    <th className="px-3 py-3 font-medium text-right">{t("sales.colAmount")}</th>
                    {withPayments && <th className="px-3 py-3 font-medium text-right">{t("sc.colReceived")}</th>}
                    {withPayments && <th className="px-3 py-3 font-medium text-right">{t("sc.colCut")}</th>}
                    {withPayments && <th className="px-3 py-3 font-medium text-right">{t("sc.colBalance")}</th>}
                    <th className="px-3 py-3 font-medium">{t("sales.colDalal")}</th>
                    <th className="px-3 py-3 font-medium">{t("sales.colTruck")}</th>
                    <th className="px-3 py-3 font-medium">{t("sales.colDriver")}</th>
                    <th className="px-3 py-3 font-medium">{t("sales.colTransport")}</th>
                    <th className="px-3 py-3 font-medium">{t("sc.colSettle")}</th>
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {withPayments && filters.from && (
                    <tr className="border-b border-[#F0EFEA] bg-[#FAFAF9] text-stone-600" data-testid="sc-opening-row">
                      <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(filters.from)}</td>
                      <td className="px-3 py-3 font-medium" colSpan={5}>{t("sc.opening")}</td>
                      <td />
                      <td />
                      <td className={`px-3 py-3 font-mono text-right ${balanceClass(statement.opening_balance)}`}>
                        {formatCurrency(statement.opening_balance)}
                      </td>
                      <td colSpan={6} />
                    </tr>
                  )}
                  {statement.rows.map((r) =>
                    r.type === "sale" ? (
                      <tr key={`sale-${r.id}`} className="border-b border-[#F0EFEA] hover:bg-[#FAFAF9] align-top" data-testid={`sc-sale-${r.id}`}>
                        <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="px-3 py-3 font-mono text-xs whitespace-nowrap">{r.bill_no || "—"}</td>
                        <td className="px-3 py-3">{r.product_name}</td>
                        <td className="px-3 py-3 font-mono text-right">{r.quantity.toLocaleString("en-IN")}</td>
                        <td className="px-3 py-3 font-mono text-right">{formatCurrency(r.rate)}</td>
                        <td className="px-3 py-3 font-mono text-right font-medium">{formatCurrency(r.amount)}</td>
                        {withPayments && <td />}
                        {withPayments && <td />}
                        {withPayments && <td className={`px-3 py-3 font-mono text-right ${balanceClass(r.running_balance)}`}>{formatCurrency(r.running_balance)}</td>}
                        <td className="px-3 py-3 text-stone-600">{r.dalal_name || "—"}</td>
                        <td className="px-3 py-3 font-mono whitespace-nowrap">{r.truck_number}</td>
                        <td className="px-3 py-3">
                          <div>{r.driver_name}</div>
                          {r.driver_phone && <div className="text-xs font-mono text-stone-500">{r.driver_phone}</div>}
                        </td>
                        <td className="px-3 py-3">{r.transport_company}</td>
                        <td className="px-3 py-3 whitespace-nowrap" data-testid={`sc-status-${r.id}`}>
                          {r.status === "settled" && (
                            <div className="text-xs font-semibold text-emerald-700">
                              {t("sc.settled")}
                              {r.settled_cut > 0 && (
                                <span className="font-normal text-stone-500"> · {t("sc.cutWord")} {formatCurrency(r.settled_cut)}</span>
                              )}
                            </div>
                          )}
                          {r.status === "part" && (
                            <div className="text-xs font-semibold text-[#B45309]">
                              {t("sc.partSettled")}
                              <span className="font-normal text-stone-500"> · {formatCurrency(r.due)} {t("sc.dueLeft")}</span>
                            </div>
                          )}
                          {r.status === "due" && <div className="text-xs text-stone-500">{t("sc.dueStatus")}</div>}
                          <div className="mt-1 flex items-center gap-2">
                            {r.status !== "settled" && (
                              <button type="button" onClick={() => openSettle(r)} data-testid={`sc-settle-${r.id}`}
                                className="inline-flex items-center gap-1 border border-[#B45309] text-[#B45309] px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-[#B45309] hover:text-[#FAFAF9] transition-colors">
                                <Check strokeWidth={1.5} className="w-3 h-3" />{t("sc.settle")}
                              </button>
                            )}
                            {(r.settled_paid > 0 || r.settled_cut > 0) && (
                              <button type="button" onClick={() => undoSettle(r)} data-testid={`sc-undo-${r.id}`}
                                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-stone-500 hover:text-red-700">
                                <Undo2 strokeWidth={1.5} className="w-3 h-3" />{t("sc.undo")}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <button type="button" onClick={() => downloadBill(r)} data-testid={`sc-bill-${r.id}`}
                            className="p-1.5 text-stone-500 hover:text-[#B45309]" title={t("sales.downloadBill")} aria-label={t("sales.downloadBill")}>
                            <FileText strokeWidth={1.5} className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ) : r.type === "payment" ? (
                      <tr key={`pay-${r.id}`} className="border-b border-[#F0EFEA] bg-emerald-50/60 align-top" data-testid={`sc-payment-${r.id}`}>
                        <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="px-3 py-3 text-xs font-semibold tracking-wide whitespace-nowrap" colSpan={2}>
                          {t("sc.payment")} · {t(`sc.mode.${r.mode}`)}
                        </td>
                        <td colSpan={3} />
                        <td className="px-3 py-3 font-mono text-right font-medium text-emerald-700">{formatCurrency(r.amount)}</td>
                        <td />
                        <td className={`px-3 py-3 font-mono text-right ${balanceClass(r.running_balance)}`}>{formatCurrency(r.running_balance)}</td>
                        <td className="px-3 py-3 text-stone-600" colSpan={5}>{r.note || ""}</td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <button type="button" onClick={() => deletePayment(r)} data-testid={`sc-del-payment-${r.id}`}
                            className="p-1.5 text-stone-500 hover:text-red-700" aria-label="Delete payment">
                            <Trash2 strokeWidth={1.5} className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={`cut-${r.id}`} className="border-b border-[#F0EFEA] bg-amber-50/70 align-top" data-testid={`sc-cut-${r.id}`}>
                        <td className="px-3 py-3 font-mono whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="px-3 py-3 text-xs font-semibold tracking-wide whitespace-nowrap" colSpan={2}>
                          {t("sc.cutRow")} · {r.truck_number}
                        </td>
                        <td colSpan={3} />
                        <td />
                        <td className="px-3 py-3 font-mono text-right font-medium text-[#B45309]">{formatCurrency(r.amount)}</td>
                        <td className={`px-3 py-3 font-mono text-right ${balanceClass(r.running_balance)}`}>{formatCurrency(r.running_balance)}</td>
                        <td className="px-3 py-3 text-stone-600" colSpan={5}>{r.note || ""}</td>
                        <td />
                      </tr>
                    )
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#78716C] bg-[#FAFAF9] font-medium" data-testid="sc-totals-row">
                    <td className="px-3 py-3 text-[11px] uppercase tracking-widest text-stone-600" colSpan={3}>
                      {t("sc.total")} · {t("sc.avgRate")}
                    </td>
                    <td className="px-3 py-3 font-mono text-right">{totals.quantity.toLocaleString("en-IN")}</td>
                    <td className="px-3 py-3 font-mono text-right">{totals.avg_rate ? formatCurrency(totals.avg_rate) : "—"}</td>
                    <td className="px-3 py-3 font-mono text-right">{formatCurrency(totals.sales_amount)}</td>
                    {withPayments && <td className="px-3 py-3 font-mono text-right text-emerald-700">{formatCurrency(totals.payments_total)}</td>}
                    {withPayments && <td className="px-3 py-3 font-mono text-right text-[#B45309]">{formatCurrency(totals.cuts_total)}</td>}
                    {withPayments && <td className={`px-3 py-3 font-mono text-right ${balanceClass(totals.closing_balance)}`}>{formatCurrency(totals.closing_balance)}</td>}
                    <td colSpan={6} />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {/* product-wise totals */}
          {statement.product_subtotals.length > 1 && (
            <div data-testid="sc-product-subtotals">
              <h2 className="text-lg font-serif text-[#1C1917] mb-2">{t("sc.subtotals")}</h2>
              <div className="bg-white border border-[#E7E5E4] overflow-x-auto max-w-xl">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                      <th className="px-3 py-2.5 font-medium">{t("sales.colProduct")}</th>
                      <th className="px-3 py-2.5 font-medium text-right">{t("sc.colTrucks")}</th>
                      <th className="px-3 py-2.5 font-medium text-right">{t("sales.colQty")}</th>
                      <th className="px-3 py-2.5 font-medium text-right">{t("sales.colAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.product_subtotals.map((p) => (
                      <tr key={p.product_name} className="border-b border-[#F0EFEA]">
                        <td className="px-3 py-2.5">{p.product_name}</td>
                        <td className="px-3 py-2.5 font-mono text-right">{p.trucks}</td>
                        <td className="px-3 py-2.5 font-mono text-right">{p.quantity.toLocaleString("en-IN")}</td>
                        <td className="px-3 py-2.5 font-mono text-right">{formatCurrency(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {withPayments && <p className="text-xs text-stone-500">{t("sc.balanceNote")}</p>}
        </>
      )}
      {loading && !statement && <p className="text-sm text-stone-500">…</p>}

      {/* ---------- Settle truck popup ---------- */}
      <Dialog open={settleOpen} onOpenChange={(open) => { if (!open && !settleSaving) setSettleOpen(false); }}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="sc-settle-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">{t("sc.settleTitle")}</DialogTitle>
            <DialogDescription className="text-sm text-stone-600">{t("sc.settleDesc")}</DialogDescription>
          </DialogHeader>
          {settleRow && (
            <div className="space-y-4">
              <div className="bg-white border border-[#E7E5E4] px-4 py-3 text-sm">
                <div className="font-mono font-medium text-[#1C1917]">
                  {settleRow.truck_number}{settleRow.bill_no ? ` · ${settleRow.bill_no}` : ""}
                </div>
                <div className="mt-1 text-stone-600">
                  {t("sc.truckDue")}: <span className="font-mono text-[#B45309]">{formatCurrency(settleRow.due)}</span>
                </div>
                <div className="text-stone-600">
                  {t("sc.availableMoney")}: <span className="font-mono text-emerald-700">{formatCurrency(unassigned)}</span>
                </div>
              </div>
              <label className="block text-[11px] uppercase tracking-widest text-stone-500">
                {t("sc.cutAmount")} <span className="normal-case tracking-normal text-stone-400">({t("sc.cutOptional")})</span>
                <input
                  type="number" inputMode="decimal" min="0" step="any" value={settle.cut}
                  onChange={(e) => changeCut(e.target.value)} className={inputCls} data-testid="sc-settle-cut"
                />
              </label>
              <label className="block text-[11px] uppercase tracking-widest text-stone-500">
                {t("sc.paidAmount")}
                <input
                  type="number" inputMode="decimal" min="0" step="any" value={settle.paid}
                  onChange={(e) => setSettle((s) => ({ ...s, paid: e.target.value }))} className={inputCls} data-testid="sc-settle-paid"
                />
              </label>
              <label className="block text-[11px] uppercase tracking-widest text-stone-500">
                {t("sc.settleDate")}
                <input
                  type="date" max={todayIso} value={settle.date}
                  onChange={(e) => setSettle((s) => ({ ...s, date: e.target.value }))} className={inputCls} data-testid="sc-settle-date"
                />
              </label>
            </div>
          )}
          {settleError && <p role="alert" className="text-sm text-red-700" data-testid="sc-settle-error">{settleError}</p>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setSettleOpen(false)} disabled={settleSaving} className={smallBtn} data-testid="sc-settle-cancel">
              {t("sales.cancelReview")}
            </button>
            <button
              type="button" onClick={saveSettle} disabled={settleSaving} data-testid="sc-settle-save"
              className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-4 py-2.5 text-xs uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-40 transition-colors"
            >
              <Check strokeWidth={1.5} className="w-4 h-4" />
              {settleSaving ? t("sales.saving") : t("sc.settleSave")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Add payment popup ---------- */}
      <Dialog open={payOpen} onOpenChange={(open) => { if (!open && !paySaving) setPayOpen(false); }}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="sc-payment-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">{t("sc.payTitle")}</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              <strong className="text-[#1C1917]">{company}</strong> — {t("sc.payDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <label className="block text-[11px] uppercase tracking-widest text-stone-500">
              {t("sc.payDate")} <span className="text-red-600">*</span>
              <input
                type="date" value={pay.date} max={todayIso}
                onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))}
                data-testid="sc-pay-date" className={`${inputCls} font-mono mt-2 normal-case tracking-normal`}
              />
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-stone-500">
              {t("sc.payAmount")} <span className="text-red-600">*</span>
              <input
                type="number" step="0.01" min="0" inputMode="decimal" value={pay.amount}
                onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))}
                data-testid="sc-pay-amount" className={`${inputCls} font-mono mt-2 normal-case tracking-normal`}
              />
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-stone-500">
              {t("sc.payMode")}
              <select
                value={pay.mode} onChange={(e) => setPay((p) => ({ ...p, mode: e.target.value }))}
                data-testid="sc-pay-mode" className={`${inputCls} mt-2 normal-case tracking-normal`}
              >
                {MODES.map((m) => <option key={m} value={m}>{t(`sc.mode.${m}`)}</option>)}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-stone-500">
              {t("sc.payNote")} <span className="normal-case tracking-normal text-stone-400">({t("sc.payNoteOptional")})</span>
              <input
                type="text" maxLength={200} value={pay.note} placeholder={t("sc.payNotePh")}
                onChange={(e) => setPay((p) => ({ ...p, note: e.target.value }))}
                data-testid="sc-pay-note" className={`${inputCls} mt-2 normal-case tracking-normal`}
              />
            </label>
          </div>
          {payError && <p role="alert" className="text-sm text-red-700" data-testid="sc-pay-error">{payError}</p>}
          <DialogFooter className="gap-2 pt-2">
            <button
              type="button" onClick={() => setPayOpen(false)} disabled={paySaving} data-testid="sc-pay-cancel"
              className="border border-[#D6D3D1] text-[#292524] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-60"
            >
              {t("sales.cancelReview")}
            </button>
            <button
              type="button" onClick={savePayment} disabled={paySaving} data-testid="sc-pay-save"
              className="bg-[#B45309] text-[#FAFAF9] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              <Check strokeWidth={1.5} className="w-4 h-4" />
              {paySaving ? t("sales.saving") : t("sc.paySave")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

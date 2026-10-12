import { useCallback, useEffect, useMemo, useState } from "react";
import { Truck, Pencil, Trash2, Save, X, CalendarDays, FileText } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/context/LangContext";
import usePageTitle from "@/hooks/usePageTitle";
import EmptyState from "@/components/EmptyState";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const inputCls =
  "w-full bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524] placeholder:text-stone-400";

function Field({ label, required, optional, children, className = "" }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-stone-500">
        {label}
        {required && <span className="text-red-600">*</span>}
        {optional && <span className="normal-case tracking-normal text-stone-400">({optional})</span>}
      </label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * SALES ENTRY — outgoing stock sold to mills, dispatched by truck.
 * Standalone like the procurement module (no link to the payment ledger).
 * Dalal (broker) is optional. Total = quantity (qtl) × rate (₹/qtl),
 * recomputed on the server so it can't drift.
 */
export default function SalesEntry() {
  const { user } = useAuth();
  const { t } = useLang();
  usePageTitle("sales.title", { isKey: true });

  const todayIso = toIsoDate(new Date());
  const thirtyDaysAgoIso = toIsoDate(new Date(Date.now() - 30 * 86400000));

  const emptyForm = {
    productId: "",
    buyer: "",
    dalal: "",
    quantity: "",
    rate: "",
    company: "",
    driver: "",
    phone: "",
    truck: "",
    dispatchDate: todayIso,
  };

  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [suggest, setSuggest] = useState({ buyers: [], dalals: [], transport_companies: [] });
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filterDate, setFilterDate] = useState(""); // "" = last 30 days

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const totalAmount = useMemo(() => {
    const q = parseFloat(form.quantity);
    const r = parseFloat(form.rate);
    if (isNaN(q) || isNaN(r)) return null;
    return +(q * r).toFixed(2);
  }, [form.quantity, form.rate]);

  const loadSales = useCallback(async () => {
    try {
      const params = filterDate
        ? { dispatch_date: filterDate }
        : { from_date: thirtyDaysAgoIso };
      const r = await api.get("/sales", { params });
      setSales(r.data || []);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }, [filterDate, thirtyDaysAgoIso]);

  const loadSuggestions = useCallback(async () => {
    try {
      const r = await api.get("/sales/suggestions");
      setSuggest(r.data || { buyers: [], dalals: [], transport_companies: [] });
    } catch {
      // autocomplete is a nicety; ignore failures
    }
  }, []);

  useEffect(() => {
    api.get("/procurement/products")
      .then((r) => setProducts(r.data || []))
      .catch((err) => toast.error(formatApiError(err)));
    loadSuggestions();
  }, [loadSuggestions]);

  useEffect(() => { loadSales(); }, [loadSales]);

  const downloadBill = async (sale) => {
    try {
      const res = await api.get(`/sales/${sale.id}/bill`, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `bill_${(sale.bill_no || sale.id.slice(0, 8)).replace(/\//g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success(t("sales.billDownloaded"));
      if (!sale.bill_no) loadSales(); // older sale just got its number
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const resetForm = () => {
    setForm({ ...emptyForm, dispatchDate: todayIso });
    setEditingId(null);
  };

  const validate = () => {
    if (!form.productId) return t("sales.err.product");
    if (!form.buyer.trim()) return t("sales.err.buyer");
    if (!(parseFloat(form.quantity) > 0)) return t("sales.err.quantity");
    if (!(parseFloat(form.rate) > 0)) return t("sales.err.rate");
    if (!form.company.trim()) return t("sales.err.company");
    if (!form.driver.trim()) return t("sales.err.driver");
    if (!form.truck.trim()) return t("sales.err.truck");
    if (form.phone.trim()) {
      let digits = form.phone.replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      if (digits.length !== 10) return t("sales.err.phone");
    }
    if (!form.dispatchDate || form.dispatchDate > todayIso) return t("sales.err.date");
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    const payload = {
      product_id: form.productId,
      buyer_name: form.buyer.trim(),
      dalal_name: form.dalal.trim() || null,
      quantity: parseFloat(form.quantity),
      rate: parseFloat(form.rate),
      transport_company: form.company.trim(),
      driver_name: form.driver.trim(),
      driver_phone: form.phone.trim() || null,
      truck_number: form.truck.trim(),
      dispatch_date: form.dispatchDate,
    };
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/sales/${editingId}`, payload);
        toast.success(t("sales.updated"));
      } else {
        const res = await api.post("/sales", payload);
        toast.success(`${t("sales.saved")} · ${res.data.bill_no}`, {
          duration: 12000,
          action: { label: t("sales.downloadBill"), onClick: () => downloadBill(res.data) },
        });
      }
      resetForm();
      await Promise.all([loadSales(), loadSuggestions()]);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      productId: s.product_id,
      buyer: s.buyer_name,
      dalal: s.dalal_name || "",
      quantity: String(s.quantity),
      rate: String(s.rate),
      company: s.transport_company,
      driver: s.driver_name,
      phone: s.driver_phone || "",
      truck: s.truck_number,
      dispatchDate: s.dispatch_date,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (s) => {
    if (!window.confirm(t("sales.confirmDelete"))) return;
    try {
      await api.delete(`/sales/${s.id}`);
      toast.success(t("sales.deleted"));
      if (editingId === s.id) resetForm();
      await loadSales();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const totals = useMemo(
    () => ({
      qty: sales.reduce((a, s) => a + s.quantity, 0),
      amount: sales.reduce((a, s) => a + s.total_amount, 0),
      trucks: sales.length,
    }),
    [sales]
  );

  return (
    <div className="space-y-8" data-testid="sales-entry-page">
      <header className="border-b border-[#E7E5E4] pb-4">
        <h1 className="text-3xl font-serif text-[#1C1917]" data-testid="sales-title">
          {t("sales.title")}
        </h1>
        <p className="mt-1 text-sm text-stone-500">{t("sales.subtitle")}</p>
      </header>

      {/* ---------- Entry form ---------- */}
      <form
        onSubmit={handleSubmit}
        data-testid="sales-form"
        className="bg-white border border-[#E7E5E4] p-6 space-y-6"
      >
        <h2 className="text-lg font-serif text-[#1C1917]">
          {editingId ? t("sales.editSale") : t("sales.newSale")}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field label={t("sales.product")} required>
            <select
              value={form.productId}
              onChange={set("productId")}
              data-testid="sales-product-select"
              className={inputCls}
            >
              <option value="">{t("sales.selectProduct")}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>

          <Field label={t("sales.buyer")} required>
            <input
              type="text" list="sales-buyers" value={form.buyer} onChange={set("buyer")}
              placeholder={t("sales.buyerPh")} data-testid="sales-buyer-input"
              className={inputCls} maxLength={120}
            />
            <datalist id="sales-buyers">
              {suggest.buyers.map((b) => <option key={b} value={b} />)}
            </datalist>
          </Field>

          <Field label={t("sales.dalal")} optional={t("sales.dalalOptional")}>
            <input
              type="text" list="sales-dalals" value={form.dalal} onChange={set("dalal")}
              placeholder={t("sales.dalalPh")} data-testid="sales-dalal-input"
              className={inputCls} maxLength={120}
            />
            <datalist id="sales-dalals">
              {suggest.dalals.map((d) => <option key={d} value={d} />)}
            </datalist>
          </Field>

          <div className="hidden md:block" />

          <Field label={t("sales.quantity")} required>
            <input
              type="number" step="0.01" min="0" inputMode="decimal"
              value={form.quantity} onChange={set("quantity")}
              placeholder={t("sales.quantityPh")} data-testid="sales-quantity-input"
              className={`${inputCls} font-mono`}
            />
          </Field>

          <Field label={t("sales.rate")} required>
            <input
              type="number" step="0.01" min="0" inputMode="decimal"
              value={form.rate} onChange={set("rate")}
              placeholder={t("sales.ratePh")} data-testid="sales-rate-input"
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>

        <div
          className="flex items-center justify-between bg-[#FBF1DE] border border-[#F0DDB4] px-5 py-4"
          data-testid="sales-amount-box"
        >
          <span className="text-sm font-medium text-[#92400E]">{t("sales.amount")}:</span>
          <span className="font-mono text-2xl text-[#92400E]" data-testid="sales-total-amount">
            {totalAmount === null ? "₹ —" : formatCurrency(totalAmount)}
          </span>
        </div>

        {/* ---------- Transport ---------- */}
        <div className="pt-5 border-t border-[#E7E5E4] space-y-5">
          <h3 className="text-xs uppercase tracking-widest text-stone-600 font-semibold">
            {t("sales.transport")}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <Field label={t("sales.company")} required>
              <input
                type="text" list="sales-companies" value={form.company} onChange={set("company")}
                placeholder={t("sales.companyPh")} data-testid="sales-company-input"
                className={inputCls} maxLength={120}
              />
              <datalist id="sales-companies">
                {suggest.transport_companies.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label={t("sales.driver")} required>
              <input
                type="text" value={form.driver} onChange={set("driver")}
                placeholder={t("sales.driverPh")} data-testid="sales-driver-input"
                className={inputCls} maxLength={120}
              />
            </Field>
            <Field label={t("sales.phone")}>
              <input
                type="tel" inputMode="tel" value={form.phone} onChange={set("phone")}
                placeholder={t("sales.phonePh")} data-testid="sales-phone-input"
                className={`${inputCls} font-mono`} maxLength={16}
              />
            </Field>
            <Field label={t("sales.truck")} required className="md:col-span-2">
              <input
                type="text" value={form.truck} onChange={set("truck")}
                placeholder={t("sales.truckPh")} data-testid="sales-truck-input"
                className={`${inputCls} font-mono uppercase placeholder:normal-case`} maxLength={20}
              />
            </Field>
            <Field
              label={t("sales.dispatchDate")} required
            >
              <input
                type="date" value={form.dispatchDate} onChange={set("dispatchDate")}
                max={todayIso} data-testid="sales-date-input"
                className={`${inputCls} font-mono`}
              />
            </Field>
          </div>
        </div>

        <div className="bg-[#F0EFEA] px-4 py-3 text-sm text-stone-600" data-testid="sales-entered-by">
          {t("sales.enteredBy")}: <strong className="text-[#1C1917]">{user?.name}</strong>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit" disabled={saving} data-testid="sales-save-btn"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-6 py-3 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-50 transition-colors"
          >
            <Save strokeWidth={1.5} className="w-4 h-4" />
            {saving ? t("sales.saving") : editingId ? t("sales.update") : t("sales.save")}
          </button>
          <button
            type="button" onClick={resetForm} data-testid="sales-clear-btn"
            className="inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-5 py-3 text-sm uppercase tracking-widest hover:bg-[#F0EFEA] transition-colors"
          >
            <X strokeWidth={1.5} className="w-4 h-4" />
            {editingId ? t("sales.cancelEdit") : t("sales.clear")}
          </button>
        </div>
      </form>

      {/* ---------- Sales list ---------- */}
      <section className="space-y-4" data-testid="sales-list-section">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-xl font-serif text-[#1C1917]">{t("sales.recent")}</h2>
          <div className="flex items-end gap-3">
            <label className="text-[11px] uppercase tracking-widest text-stone-500">
              <span className="flex items-center gap-1.5">
                <CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" />
                {t("sales.filterDate")}
              </span>
              <input
                type="date" value={filterDate} max={todayIso}
                onChange={(e) => setFilterDate(e.target.value)}
                data-testid="sales-filter-date"
                className="mt-1 block bg-transparent border-b border-[#D6D3D1] py-1.5 font-mono text-sm normal-case tracking-normal text-[#1C1917] focus:outline-none focus:border-[#292524]"
              />
            </label>
            <button
              type="button" onClick={() => setFilterDate("")}
              disabled={!filterDate} data-testid="sales-filter-reset"
              className="border border-[#D6D3D1] px-3 py-2 text-xs uppercase tracking-widest text-[#292524] hover:bg-[#F0EFEA] disabled:opacity-40 transition-colors"
            >
              {t("sales.allDates")}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-px bg-[#E7E5E4] border border-[#E7E5E4]">
          {[
            { label: t("sales.totalQty"), value: `${totals.qty.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Qtl`, id: "qty" },
            { label: t("sales.totalAmount"), value: formatCurrency(totals.amount), id: "amount" },
            { label: t("sales.trucks"), value: totals.trucks, id: "trucks" },
          ].map((c) => (
            <div key={c.id} className="bg-white px-4 py-3" data-testid={`sales-total-${c.id}`}>
              <div className="text-[10px] uppercase tracking-widest text-stone-500">{c.label}</div>
              <div className="mt-1 font-mono text-lg text-[#1C1917]">{c.value}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-[#E7E5E4] overflow-x-auto">
          {sales.length === 0 ? (
            <EmptyState icon={Truck} label={t("sales.none")} testid="sales-empty" />
          ) : (
            <table className="w-full text-sm" data-testid="sales-table">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4]">
                  {["colDate", "colBill", "colProduct", "colBuyer", "colDalal", "colQty", "colRate", "colAmount", "colTruck", "colDriver", "colTransport", "colBy"].map((k) => (
                    <th key={k} className="px-3 py-3 font-medium whitespace-nowrap">{t(`sales.${k}`)}</th>
                  ))}
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className="border-b border-[#F0EFEA] hover:bg-[#FAFAF9]" data-testid={`sales-row-${s.id}`}>
                    <td className="px-3 py-3 whitespace-nowrap font-mono">{formatDate(s.dispatch_date)}</td>
                    <td className="px-3 py-3 font-mono whitespace-nowrap text-xs">{s.bill_no || "—"}</td>
                    <td className="px-3 py-3">{s.product_name}</td>
                    <td className="px-3 py-3">{s.buyer_name}</td>
                    <td className="px-3 py-3 text-stone-600">{s.dalal_name || "—"}</td>
                    <td className="px-3 py-3 font-mono text-right">{s.quantity.toLocaleString("en-IN")}</td>
                    <td className="px-3 py-3 font-mono text-right">{formatCurrency(s.rate)}</td>
                    <td className="px-3 py-3 font-mono text-right font-medium">{formatCurrency(s.total_amount)}</td>
                    <td className="px-3 py-3 font-mono whitespace-nowrap">{s.truck_number}</td>
                    <td className="px-3 py-3">
                      <div>{s.driver_name}</div>
                      {s.driver_phone && <div className="text-xs font-mono text-stone-500">{s.driver_phone}</div>}
                    </td>
                    <td className="px-3 py-3">{s.transport_company}</td>
                    <td className="px-3 py-3 text-stone-600">{s.entered_by}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <button type="button" onClick={() => downloadBill(s)} data-testid={`sales-bill-${s.id}`}
                        className="p-1.5 text-stone-500 hover:text-[#B45309]" aria-label={t("sales.downloadBill")}
                        title={t("sales.downloadBill")}>
                        <FileText strokeWidth={1.5} className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => startEdit(s)} data-testid={`sales-edit-${s.id}`}
                        className="p-1.5 text-stone-500 hover:text-[#292524]" aria-label="Edit">
                        <Pencil strokeWidth={1.5} className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => handleDelete(s)} data-testid={`sales-delete-${s.id}`}
                        className="p-1.5 text-stone-500 hover:text-red-700" aria-label="Delete">
                        <Trash2 strokeWidth={1.5} className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

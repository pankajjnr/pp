import { useCallback, useEffect, useMemo, useState } from "react";
import { Truck, Pencil, Trash2, Save, X, CalendarDays, FileText, Check, Building2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
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


// ---- input helpers (shared by the form and the review popup) ---------------
const plainHandler = (setter, key) => (e) => setter((f) => ({ ...f, [key]: e.target.value }));

// Names are CAPITALS only: convert as the person types, and keep the cursor
// where it was so editing in the middle of a name doesn't jump to the end.
const upperHandler = (setter, key) => (e) => {
  const el = e.target;
  const pos = el.selectionStart;
  const value = el.value.toUpperCase();
  setter((f) => ({ ...f, [key]: value }));
  requestAnimationFrame(() => {
    try { el.setSelectionRange(pos, pos); } catch { /* input not focusable */ }
  });
};

// Phone: digits only, never more than 10. A pasted "+91 98765 43210" or
// "098765 43210" is reduced to the plain 10-digit number.
function cleanPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 10);
}
const phoneHandler = (setter) => (e) =>
  setter((f) => ({ ...f, phone: cleanPhone(e.target.value) }));

/**
 * All editable sale fields. Rendered twice: in the main form and inside the
 * review popup (where the last corrections are made before saving).
 */
function SaleFields({ v, onText, onUpper, onPhone, products, suggest, todayIso, t, idp, tp, editingBuyer, setProduct }) {
  const q = parseFloat(v.quantity);
  const r = parseFloat(v.rate);
  const totalAmount = isNaN(q) || isNaN(r) ? null : +(q * r).toFixed(2);

  // One grain per company: a known company can only be sold its own grain.
  const buyerKey = v.buyer.trim().replace(/\s+/g, " ").toUpperCase();
  const known = (suggest.buyer_products || {})[buyerKey] || [];
  // the only truck of a company may still change grain while being edited
  const freeForEdit = !!editingBuyer && editingBuyer === buyerKey && ((suggest.buyer_trucks || {})[buyerKey] || 0) <= 1;
  const allowed = freeForEdit ? [] : known;
  const lockedProductId = allowed.length === 1 ? allowed[0].product_id : null;
  const productOptions = allowed.length > 0 ? products.filter((p) => allowed.some((a) => a.product_id === p.id)) : products;
  useEffect(() => {
    if (lockedProductId && v.productId !== lockedProductId) setProduct(lockedProductId);
  }, [lockedProductId, v.productId, setProduct]);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field label={t("sales.product")} required>
          <select
            value={v.productId}
            onChange={onText("productId")}
            disabled={!!lockedProductId}
            data-testid={`${tp}product-select`}
            className={inputCls}
          >
            <option value="">{t("sales.selectProduct")}</option>
            {productOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {lockedProductId && (
            <p className="mt-1 text-xs text-[#B45309]" data-testid={`${tp}grain-locked`}>
              {t("sales.grainLocked").replace("{company}", buyerKey).replace("{grain}", allowed[0].product_name)}
            </p>
          )}
        </Field>

        <Field label={t("sales.buyer")} required>
          <input
            type="text" list={`${idp}-buyers`} value={v.buyer} onChange={onUpper("buyer")}
            placeholder={t("sales.buyerPh")} data-testid={`${tp}buyer-input`}
            className={inputCls} maxLength={120}
          />
          <datalist id={`${idp}-buyers`}>
            {suggest.buyers.map((b) => <option key={b} value={b} />)}
          </datalist>
        </Field>

        <Field label={t("sales.dalal")} optional={t("sales.dalalOptional")}>
          <input
            type="text" list={`${idp}-dalals`} value={v.dalal} onChange={onUpper("dalal")}
            placeholder={t("sales.dalalPh")} data-testid={`${tp}dalal-input`}
            className={inputCls} maxLength={120}
          />
          <datalist id={`${idp}-dalals`}>
            {suggest.dalals.map((d) => <option key={d} value={d} />)}
          </datalist>
        </Field>

        <div className="hidden md:block" />

        <Field label={t("sales.quantity")} required>
          <input
            type="number" step="0.01" min="0" inputMode="decimal"
            value={v.quantity} onChange={onText("quantity")}
            placeholder={t("sales.quantityPh")} data-testid={`${tp}quantity-input`}
            className={`${inputCls} font-mono`}
          />
        </Field>

        <Field label={t("sales.rate")} required>
          <input
            type="number" step="0.01" min="0" inputMode="decimal"
            value={v.rate} onChange={onText("rate")}
            placeholder={t("sales.ratePh")} data-testid={`${tp}rate-input`}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </div>

      <div
        className="flex items-center justify-between bg-[#FBF1DE] border border-[#F0DDB4] px-5 py-4"
        data-testid={`${tp}amount-box`}
      >
        <span className="text-sm font-medium text-[#92400E]">{t("sales.amount")}:</span>
        <span className="font-mono text-2xl text-[#92400E]" data-testid={`${tp}total-amount`}>
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
              type="text" list={`${idp}-companies`} value={v.company} onChange={onUpper("company")}
              placeholder={t("sales.companyPh")} data-testid={`${tp}company-input`}
              className={inputCls} maxLength={120}
            />
            <datalist id={`${idp}-companies`}>
              {suggest.transport_companies.map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label={t("sales.driver")} required>
            <input
              type="text" value={v.driver} onChange={onUpper("driver")}
              placeholder={t("sales.driverPh")} data-testid={`${tp}driver-input`}
              className={inputCls} maxLength={120}
            />
          </Field>
          <Field label={t("sales.phone")}>
            <input
              type="tel" inputMode="numeric" pattern="[0-9]*" value={v.phone} onChange={onPhone}
              placeholder={t("sales.phonePh")} data-testid={`${tp}phone-input`}
              className={`${inputCls} font-mono`} maxLength={10}
            />
          </Field>
          <Field label={t("sales.truck")} required className="md:col-span-2">
            <input
              type="text" value={v.truck} onChange={onUpper("truck")}
              placeholder={t("sales.truckPh")} data-testid={`${tp}truck-input`}
              className={`${inputCls} font-mono uppercase placeholder:normal-case`} maxLength={20}
            />
          </Field>
          <Field
            label={t("sales.dispatchDate")} required
          >
            <input
              type="date" value={v.dispatchDate} onChange={onText("dispatchDate")}
              max={todayIso} data-testid={`${tp}date-input`}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>
      </div>
    </>
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
  const [editingBuyer, setEditingBuyer] = useState(null); // company of the sale being edited
  const [saving, setSaving] = useState(false);
  const [filterDate, setFilterDate] = useState(""); // "" = last 30 days

  const set = (key) => plainHandler(setForm, key);
  const setUpper = (key) => upperHandler(setForm, key);
  const onPhone = phoneHandler(setForm);

  // Review popup: works on a COPY of the form, so nothing in the form changes
  // until the person confirms. All last-minute corrections happen in the popup.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [draft, setDraft] = useState(emptyForm);
  const [reviewError, setReviewError] = useState("");
  const dSet = (key) => plainHandler(setDraft, key);
  const dUpper = (key) => upperHandler(setDraft, key);
  const dPhone = phoneHandler(setDraft);

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
    setEditingBuyer(null);
  };

  const validate = (d) => {
    if (!d.productId) return t("sales.err.product");
    if (!d.buyer.trim()) return t("sales.err.buyer");
    if (!(parseFloat(d.quantity) > 0)) return t("sales.err.quantity");
    if (!(parseFloat(d.rate) > 0)) return t("sales.err.rate");
    if (!d.company.trim()) return t("sales.err.company");
    if (!d.driver.trim()) return t("sales.err.driver");
    if (!d.truck.trim()) return t("sales.err.truck");
    if (d.phone && !/^\d{10}$/.test(d.phone)) return t("sales.err.phone");
    if (!d.dispatchDate || d.dispatchDate > todayIso) return t("sales.err.date");
    return null;
  };

  // Step 1: form submit -> validate -> open the review popup. NO API call yet.
  const openReview = (e) => {
    e.preventDefault();
    const problem = validate(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    setDraft({ ...form });
    setReviewError("");
    setReviewOpen(true);
  };

  const closeReview = () => {
    if (saving) return;
    setReviewOpen(false);
    setReviewError("");
  };

  // Step 2: confirmed in the popup -> save exactly what the popup shows.
  const confirmSave = async () => {
    const problem = validate(draft);
    if (problem) {
      setReviewError(problem);
      return;
    }
    setReviewError("");
    const payload = {
      product_id: draft.productId,
      buyer_name: draft.buyer.trim(),
      dalal_name: draft.dalal.trim() || null,
      quantity: parseFloat(draft.quantity),
      rate: parseFloat(draft.rate),
      transport_company: draft.company.trim(),
      driver_name: draft.driver.trim(),
      driver_phone: draft.phone || null,
      truck_number: draft.truck.trim(),
      dispatch_date: draft.dispatchDate,
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
      setReviewOpen(false);
      resetForm();
      await Promise.all([loadSales(), loadSuggestions()]);
    } catch (err) {
      setReviewError(formatApiError(err)); // stay in the popup so nothing typed is lost
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setEditingBuyer(s.buyer_name.trim().replace(/\s+/g, " ").toUpperCase());
    setForm({
      productId: s.product_id,
      buyer: s.buyer_name.toUpperCase(),
      dalal: (s.dalal_name || "").toUpperCase(),
      quantity: String(s.quantity),
      rate: String(s.rate),
      company: s.transport_company.toUpperCase(),
      driver: s.driver_name.toUpperCase(),
      phone: cleanPhone(s.driver_phone),
      truck: s.truck_number.toUpperCase(),
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
      <header className="border-b border-[#E7E5E4] pb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif text-[#1C1917]" data-testid="sales-title">
            {t("sales.title")}
          </h1>
          <p className="mt-1 text-sm text-stone-500">{t("sales.subtitle")}</p>
        </div>
        <Link
          to="/sales/companies" data-testid="sales-to-companies"
          className="inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] transition-colors"
        >
          <Building2 strokeWidth={1.5} className="w-4 h-4" />
          {t("nav.salesCompanies")}
        </Link>
      </header>

      {/* ---------- Entry form ---------- */}
      <form
        onSubmit={openReview}
        data-testid="sales-form"
        className="bg-white border border-[#E7E5E4] p-6 space-y-6"
      >
        <h2 className="text-lg font-serif text-[#1C1917]">
          {editingId ? t("sales.editSale") : t("sales.newSale")}
        </h2>

        <SaleFields
          v={form} onText={set} onUpper={setUpper} onPhone={onPhone}
          products={products} suggest={suggest} todayIso={todayIso} t={t}
          editingBuyer={editingBuyer} setProduct={(id) => setForm((f) => ({ ...f, productId: id }))}
          idp="sales" tp="sales-"
        />

        <div className="bg-[#F0EFEA] px-4 py-3 text-sm text-stone-600" data-testid="sales-entered-by">
          {t("sales.enteredBy")}: <strong className="text-[#1C1917]">{user?.name}</strong>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit" data-testid="sales-save-btn"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-6 py-3 text-sm uppercase tracking-widest hover:bg-[#92400E] transition-colors"
          >
            <Save strokeWidth={1.5} className="w-4 h-4" />
            {editingId ? t("sales.update") : t("sales.save")}
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

      {/* ---------- Review popup: confirm everything, and fix anything here ---------- */}
      <Dialog open={reviewOpen} onOpenChange={(open) => { if (!open) closeReview(); }}>
        <DialogContent
          className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-3xl max-h-[92vh] overflow-y-auto"
          data-testid="sales-review-dialog"
        >
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">
              {editingId ? t("sales.reviewTitleEdit") : t("sales.reviewTitle")}
            </DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              {t("sales.reviewDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <SaleFields
              v={draft} onText={dSet} onUpper={dUpper} onPhone={dPhone}
              products={products} suggest={suggest} todayIso={todayIso} t={t}
              editingBuyer={editingBuyer} setProduct={(id) => setDraft((d) => ({ ...d, productId: id }))}
              idp="review" tp="review-"
            />
            <div className="bg-[#F0EFEA] px-4 py-3 text-sm text-stone-600">
              {t("sales.enteredBy")}: <strong className="text-[#1C1917]">{user?.name}</strong>
            </div>
          </div>

          {reviewError && (
            <p role="alert" className="text-sm text-red-700" data-testid="sales-review-error">
              {reviewError}
            </p>
          )}

          <DialogFooter className="gap-2 pt-2">
            <button
              type="button" onClick={closeReview} disabled={saving} data-testid="sales-review-cancel-btn"
              className="border border-[#D6D3D1] text-[#292524] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-60"
            >
              {t("sales.cancelReview")}
            </button>
            <button
              type="button" onClick={confirmSave} disabled={saving} data-testid="sales-review-confirm-btn"
              className="bg-[#B45309] text-[#FAFAF9] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              <Check strokeWidth={1.5} className="w-4 h-4" />
              {saving ? t("sales.saving") : editingId ? t("sales.confirmUpdate") : t("sales.confirmSave")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

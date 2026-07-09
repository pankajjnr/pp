import { useEffect, useMemo, useState } from "react";
import {
  Plus, Package, Scale, IndianRupee, CalendarDays, Check, ChevronsUpDown,
  Download, FileDown, Settings, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/context/LangContext";
import usePageTitle from "@/hooks/usePageTitle";
import EmptyState from "@/components/EmptyState";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * MODULE 1 — STANDALONE PROCUREMENT LOG
 * - Weight in Quintal.
 * - Entry date restricted to today or yesterday (server enforces too).
 * - Two-step save: review dialog before the POST fires.
 * - Today's entries shown grouped by product with subtotals.
 * - Inline "Manage Products" dialog to add/remove master products.
 * - PDF exports (today-only / full history).
 */
export default function ProcurementLog() {
  const { user } = useAuth();
  const { t } = useLang();
  usePageTitle("log.title", { isKey: true });
  const isAdmin = user?.role === "admin";

  const todayIso = toIsoDate(new Date());
  const yesterdayIso = toIsoDate(new Date(Date.now() - 86400000));

  const [clients, setClients] = useState([]);
  const [products, setProducts] = useState([]);
  const [todaysEntries, setTodaysEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  // form state
  const [entryDate, setEntryDate] = useState(todayIso);
  const [clientId, setClientId] = useState("");
  const [productId, setProductId] = useState("");
  const [weight, setWeight] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);

  const [clientOpen, setClientOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);

  // review dialog (pre-save) & saved-confirmation (post-save)
  const [reviewOpen, setReviewOpen] = useState(false);
  const [savedEntry, setSavedEntry] = useState(null);

  // product management dialog
  const [manageOpen, setManageOpen] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [addingProduct, setAddingProduct] = useState(false);
  const [deletingProductId, setDeletingProductId] = useState(null);

  // PDF download state
  const [downloading, setDownloading] = useState(false);

  const totalAmount = useMemo(() => {
    const w = parseFloat(weight);
    const r = parseFloat(rate);
    if (isNaN(w) || isNaN(r)) return 0;
    return +(w * r).toFixed(2);
  }, [weight, rate]);

  const selectedClient = clients.find((c) => c.id === clientId);
  const selectedProduct = products.find((p) => p.id === productId);

  const fetchTodaysEntries = async () => {
    const r = await api.get(`/procurement/entries?entry_date=${todayIso}`);
    setTodaysEntries(r.data || []);
  };

  const refreshProducts = async () => {
    const r = await api.get("/procurement/products");
    setProducts(r.data || []);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cRes, pRes] = await Promise.all([
        api.get("/clients"),
        api.get("/procurement/products"),
      ]);
      setClients(cRes.data || []);
      setProducts(pRes.data || []);
      await fetchTodaysEntries();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const resetForm = () => {
    setEntryDate(todayIso);
    setClientId("");
    setProductId("");
    setWeight("");
    setRate("");
  };

  // Step 1: form submit → validate → open review dialog. NO API call yet.
  const openReview = (e) => {
    e.preventDefault();
    if (!clientId) return toast.error("Select a client");
    if (!productId) return toast.error("Select a product");
    if (!weight || Number(weight) <= 0) return toast.error("Weight must be > 0");
    if (!rate || Number(rate) <= 0) return toast.error("Rate must be > 0");
    if (entryDate !== todayIso && entryDate !== yesterdayIso) {
      return toast.error("Entry date must be today or yesterday");
    }
    setReviewOpen(true);
  };

  // Step 2: user confirmed → actually POST.
  const confirmSave = async () => {
    setSaving(true);
    try {
      const res = await api.post("/procurement/entries", {
        entry_date: entryDate,
        client_id: clientId,
        product_id: productId,
        weight: Number(weight),
        rate: Number(rate),
      });
      setSavedEntry(res.data);      // reveal "Saved" view inside same dialog
      resetForm();
      await fetchTodaysEntries();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const closeReviewDialog = () => {
    setReviewOpen(false);
    setSavedEntry(null);
  };

  const addProduct = async () => {
    const name = newProductName.trim();
    if (!name) return toast.error("Enter a product name");
    setAddingProduct(true);
    try {
      await api.post("/procurement/products", { name });
      setNewProductName("");
      await refreshProducts();
      toast.success(`Added product “${name}”`);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setAddingProduct(false);
    }
  };

  const deleteProduct = async (product) => {
    if (!isAdmin) return toast.error("Only admin can delete products");
    const ok = window.confirm(
      `Delete product “${product.name}”?\n\nExisting procurement entries will keep their product label ` +
      `(entries store the product name at the time they were logged). This only removes it from the master list.`
    );
    if (!ok) return;
    setDeletingProductId(product.id);
    try {
      await api.delete(`/procurement/products/${product.id}`);
      await refreshProducts();
      if (productId === product.id) setProductId("");
      toast.success(`Removed “${product.name}” from master list`);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setDeletingProductId(null);
    }
  };

  const downloadPdf = async ({ todayOnly } = {}) => {
    setDownloading(true);
    try {
      const url = todayOnly
        ? `/procurement/entries/export?entry_date=${todayIso}`
        : `/procurement/entries/export`;
      const res = await api.get(url, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      const suffix = todayOnly ? todayIso : "all";
      a.download = `procurement_${suffix}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success("PDF downloaded");
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setDownloading(false);
    }
  };

  // Group today's entries by product_name for the "today" section
  const groupedToday = useMemo(() => {
    const groups = new Map();
    for (const r of todaysEntries) {
      const key = r.product_name || "—";
      if (!groups.has(key)) groups.set(key, { product_name: key, entries: [], weight: 0, amount: 0 });
      const g = groups.get(key);
      g.entries.push(r);
      g.weight += Number(r.weight || 0);
      g.amount += Number(r.total_amount || 0);
    }
    // most recent entry first within a group
    for (const g of groups.values()) {
      g.entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    // groups alphabetically
    return [...groups.values()].sort((a, b) => a.product_name.localeCompare(b.product_name));
  }, [todaysEntries]);

  return (
    <div className="space-y-8" data-testid="procurement-log-page">
      {/* Header */}
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">{t("proc.module")} 01</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="procurement-log-title">{t("log.title")}</h1>
          <p className="text-sm text-stone-500 mt-1">{t("log.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setManageOpen(true)} data-testid="manage-products-btn"
            className="inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] transition-colors">
            <Settings strokeWidth={1.5} className="w-3.5 h-3.5" /> {t("log.manageProducts")}
          </button>
          <button onClick={() => downloadPdf({ todayOnly: true })} disabled={downloading || todaysEntries.length === 0}
            data-testid="download-today-pdf-btn"
            className="inline-flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Download strokeWidth={1.5} className="w-3.5 h-3.5" /> {t("log.todayPdf")}
          </button>
          <button onClick={() => downloadPdf({ todayOnly: false })} disabled={downloading}
            data-testid="download-all-pdf-btn"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <FileDown strokeWidth={1.5} className="w-3.5 h-3.5" />
            {downloading ? t("log.preparing") : t("log.fullPdf")}
          </button>
        </div>
      </header>

      {/* Entry Form */}
      <form onSubmit={openReview} data-testid="procurement-form" className="bg-white border border-[#E7E5E4] p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-5">
          <FormField label="Date" icon={<CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
              min={yesterdayIso} max={todayIso} data-testid="procurement-date-input" required
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
            <p className="mt-1 text-[10px] text-stone-400">Only today or yesterday allowed</p>
          </FormField>

          <div className="md:col-span-2">
            <FormField label="Client Name">
              <Popover open={clientOpen} onOpenChange={setClientOpen}>
                <PopoverTrigger asChild>
                  <button type="button" data-testid="procurement-client-trigger"
                    className="mt-0 w-full flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524]">
                    <span className={cn(!selectedClient && "text-stone-400")}>
                      {selectedClient ? formatClientName(selectedClient.name) : "Select client…"}
                    </span>
                    <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
                  <Command>
                    <CommandInput placeholder="Search client…" data-testid="procurement-client-search" />
                    <CommandList>
                      <CommandEmpty>No clients found. Add via Clients page.</CommandEmpty>
                      <CommandGroup>
                        {clients.map((c) => (
                          <CommandItem key={c.id} value={c.name}
                            onSelect={() => { setClientId(c.id); setClientOpen(false); }}
                            data-testid={`procurement-client-opt-${c.id}`}>
                            <Check className={cn("mr-2 h-4 w-4", clientId === c.id ? "opacity-100" : "opacity-0")} />
                            {formatClientName(c.name)}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </FormField>
          </div>

          <FormField label="Product">
            <Popover open={productOpen} onOpenChange={setProductOpen}>
              <PopoverTrigger asChild>
                <button type="button" data-testid="procurement-product-trigger"
                  className="w-full flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524]">
                  <span className={cn(!selectedProduct && "text-stone-400")}>
                    {selectedProduct ? selectedProduct.name : "Select product…"}
                  </span>
                  <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
                <Command>
                  <CommandInput placeholder="Search product…" data-testid="procurement-product-search" />
                  <CommandList>
                    <CommandEmpty>
                      <div className="text-center text-sm">
                        No products.
                        <button type="button" onClick={() => { setProductOpen(false); setManageOpen(true); }}
                          className="ml-1 underline text-[#292524]" data-testid="empty-add-product-btn">
                          Add one
                        </button>
                      </div>
                    </CommandEmpty>
                    <CommandGroup>
                      {products.map((p) => (
                        <CommandItem key={p.id} value={p.name}
                          onSelect={() => { setProductId(p.id); setProductOpen(false); }}
                          data-testid={`procurement-product-opt-${p.id}`}>
                          <Check className={cn("mr-2 h-4 w-4", productId === p.id ? "opacity-100" : "opacity-0")} />
                          {p.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </FormField>

          <FormField label="Weight (Quintal)" icon={<Scale strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="number" step="0.01" min="0" value={weight} onChange={(e) => setWeight(e.target.value)}
              placeholder="0.00" required data-testid="procurement-weight-input"
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </FormField>

          <FormField label="Rate (₹/Quintal)" icon={<IndianRupee strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder="0.00" required data-testid="procurement-rate-input"
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </FormField>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-end justify-between gap-4 pt-3 border-t border-dashed border-[#E7E5E4]">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-stone-500">Total Amount (read-only)</div>
            <div className="mt-1 font-mono text-3xl text-[#1C1917]" data-testid="procurement-total-amount">
              {formatCurrency(totalAmount)}
            </div>
            <div className="text-[11px] font-mono text-stone-400 mt-0.5">= weight (qtl) × rate (₹/qtl)</div>
          </div>
          <button type="submit" data-testid="procurement-submit-btn"
            className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-6 py-3 text-sm uppercase tracking-widest hover:bg-[#92400E] transition-colors">
            <Plus strokeWidth={1.5} className="w-4 h-4" />
            {t("log.reviewAndSave")}
          </button>
        </div>
      </form>

      {/* Today's entries — grouped by product */}
      <section className="space-y-4" data-testid="today-section">
        <div className="flex items-center justify-between border-b border-[#E7E5E4] pb-2">
          <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold flex items-center gap-2">
            <Package strokeWidth={1.5} className="w-4 h-4" /> Today&apos;s Procurement · <span className="font-mono">{formatDate(todayIso)}</span>
          </h2>
          <span className="text-xs text-stone-500 font-mono">
            {loading ? "Loading…" : `${todaysEntries.length} entries · ${groupedToday.length} product${groupedToday.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {todaysEntries.length === 0 ? (
          <div className="bg-white border border-[#E7E5E4] py-10 text-center text-stone-500 italic">
            No procurement recorded today yet. Log your first entry above.
          </div>
        ) : (
          <>
            {groupedToday.map((g) => (
              <div key={g.product_name} className="bg-white border border-[#E7E5E4]" data-testid={`today-group-${g.product_name}`}>
                <div className="px-5 py-3 border-b border-[#E7E5E4] bg-[#FAFAF9] flex items-center justify-between">
                  <h3 className="text-sm font-serif text-[#1C1917] flex items-center gap-2">
                    <Package strokeWidth={1.5} className="w-4 h-4" />
                    {g.product_name}
                  </h3>
                  <span className="text-[11px] uppercase tracking-widest text-stone-500 font-mono">
                    {g.entries.length} entr{g.entries.length === 1 ? "y" : "ies"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                      <tr>
                        <th className="text-left px-5 py-2.5 font-medium">Time</th>
                        <th className="text-left px-5 py-2.5 font-medium">Client Name</th>
                        <th className="text-right px-5 py-2.5 font-medium">Weight (Qtl)</th>
                        <th className="text-right px-5 py-2.5 font-medium">Rate (₹/Qtl)</th>
                        <th className="text-right px-5 py-2.5 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E7E5E4]">
                      {g.entries.map((r) => (
                        <tr key={r.id} className="hover:bg-[#FAFAF9]" data-testid={`procurement-row-${r.id}`}>
                          <td className="px-5 py-2.5 font-mono text-[12px] text-stone-500">
                            {new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
                          </td>
                          <td className="px-5 py-2.5">{formatClientName(r.client_name)}</td>
                          <td className="px-5 py-2.5 text-right font-mono">{r.weight.toLocaleString("en-IN")}</td>
                          <td className="px-5 py-2.5 text-right font-mono">{formatCurrency(r.rate)}</td>
                          <td className="px-5 py-2.5 text-right font-mono font-semibold">{formatCurrency(r.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-[#FAFAF9] border-t-2 border-[#78716C] text-[#1C1917]">
                      <tr data-testid={`today-subtotal-${g.product_name}`}>
                        <td colSpan={2} className="px-5 py-2.5 text-[11px] uppercase tracking-widest text-stone-500">
                          Subtotal · {g.product_name}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono font-semibold">
                          {g.weight.toLocaleString("en-IN")}
                        </td>
                        <td></td>
                        <td className="px-5 py-2.5 text-right font-mono font-semibold">
                          {formatCurrency(g.amount)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            ))}
            <TodayGrandTotal rows={todaysEntries} />
          </>
        )}
      </section>

      {/* Review-then-Save Dialog (Edit 5) */}
      <Dialog open={reviewOpen} onOpenChange={(v) => { if (!v) closeReviewDialog(); }}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="review-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">
              {savedEntry ? "Entry saved" : "Review before saving"}
            </DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              {savedEntry
                ? "Recorded in the ledger. Details below."
                : "Nothing has been saved yet. Please verify the details, then confirm."}
            </DialogDescription>
          </DialogHeader>
          <dl className="mt-2 divide-y divide-[#E7E5E4] border-y border-[#E7E5E4]">
            <DetailRow label="Date"
              value={formatDate(savedEntry ? savedEntry.entry_date : entryDate)}
              testid="review-date" />
            <DetailRow label="Client Name"
              value={formatClientName(savedEntry ? savedEntry.client_name : (selectedClient?.name ?? "—"))}
              testid="review-client" />
            <DetailRow label="Product"
              value={savedEntry ? savedEntry.product_name : (selectedProduct?.name ?? "—")}
              testid="review-product" />
            <DetailRow label="Weight"
              value={`${(savedEntry ? savedEntry.weight : Number(weight || 0)).toLocaleString("en-IN")} Quintal`}
              testid="review-weight" mono />
            <DetailRow label="Rate"
              value={`${formatCurrency(savedEntry ? savedEntry.rate : Number(rate || 0))} / Quintal`}
              testid="review-rate" mono />
            <DetailRow label="Total Amount"
              value={formatCurrency(savedEntry ? savedEntry.total_amount : totalAmount)}
              testid="review-total" mono emphasis />
          </dl>
          <DialogFooter className="gap-2 pt-4">
            {savedEntry ? (
              <button onClick={closeReviewDialog} data-testid="close-saved-btn"
                className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
                Done
              </button>
            ) : (
              <>
                <button onClick={() => setReviewOpen(false)} disabled={saving} data-testid="review-cancel-btn"
                  className="border border-[#D6D3D1] text-[#292524] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-60">
                  Cancel / Edit
                </button>
                <button onClick={confirmSave} disabled={saving} data-testid="review-save-btn"
                  className="bg-[#B45309] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60 inline-flex items-center gap-2">
                  <Check strokeWidth={1.5} className="w-4 h-4" />
                  {saving ? "Saving…" : "Save Entry"}
                </button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Products Dialog (Edit 4) */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-lg" data-testid="manage-products-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">Manage Products</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Add a new product or remove one from the master list.
              {!isAdmin && <span className="block mt-1 text-orange-800 text-xs">Only admin can delete products.</span>}
            </DialogDescription>
          </DialogHeader>

          {/* Add product */}
          <div className="pt-2">
            <label className="text-[11px] uppercase tracking-widest text-stone-500">Add new product</label>
            <div className="mt-2 flex items-baseline gap-2 border-b border-[#D6D3D1]">
              <input value={newProductName} onChange={(e) => setNewProductName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addProduct(); } }}
                placeholder="e.g. Mustard, Barley, Paddy…"
                data-testid="new-product-name"
                className="flex-1 bg-transparent py-2 text-sm focus:outline-none placeholder-stone-300" />
              <button onClick={addProduct} disabled={addingProduct || !newProductName.trim()}
                data-testid="add-product-btn"
                className="bg-[#292524] text-[#FAFAF9] px-3 py-1.5 text-xs uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
                {addingProduct ? "Adding…" : "Add"}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-stone-400">
              Available across Procurement Log, Product Ledger, and Client Subledger.
            </p>
          </div>

          {/* List */}
          <div className="mt-4">
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center justify-between">
              <span>Existing products</span>
              <span className="font-mono">{products.length}</span>
            </label>
            <ul className="mt-2 divide-y divide-[#E7E5E4] border border-[#E7E5E4] bg-white max-h-64 overflow-y-auto">
              {products.length === 0 ? (
                <li className="text-center text-stone-500 italic py-4 text-sm">No products yet.</li>
              ) : products.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-[#FAFAF9]"
                  data-testid={`manage-row-${p.id}`}>
                  <span className="text-sm">{p.name}</span>
                  {isAdmin && (
                    <button onClick={() => deleteProduct(p)} disabled={deletingProductId === p.id}
                      data-testid={`delete-product-${p.id}`}
                      className="text-stone-500 hover:text-red-700 disabled:opacity-40 inline-flex items-center gap-1 text-xs">
                      {deletingProductId === p.id
                        ? <><X strokeWidth={1.5} className="w-3.5 h-3.5" /> Removing…</>
                        : <><Trash2 strokeWidth={1.5} className="w-3.5 h-3.5" /> Delete</>}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <DialogFooter className="pt-4">
            <button onClick={() => setManageOpen(false)} data-testid="close-manage-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
              Done
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TodayGrandTotal({ rows }) {
  const totalWeight = rows.reduce((s, r) => s + Number(r.weight || 0), 0);
  const totalCost = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  return (
    <div className="px-5 py-4 bg-[#FEF3C7] border-2 border-[#B45309] flex flex-wrap justify-between gap-x-8 gap-y-1 text-xs uppercase tracking-widest text-[#92400E]"
      data-testid="today-grand-total">
      <div>Today&apos;s Total Weight: <span className="font-mono ml-1 text-2xl font-bold text-[#B45309]" data-testid="today-total-weight">
        {totalWeight.toLocaleString("en-IN")} qtl
      </span></div>
      <div>Today&apos;s Total Cost: <span className="font-mono ml-1 text-2xl font-bold text-[#B45309]" data-testid="today-total-cost">
        {formatCurrency(totalCost)}
      </span></div>
    </div>
  );
}

function DetailRow({ label, value, testid, mono, emphasis }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-[11px] uppercase tracking-widest text-stone-500">{label}</dt>
      <dd className={cn(
        "text-right",
        mono ? "font-mono" : "",
        emphasis ? "text-lg font-semibold text-[#1C1917]" : "text-sm text-[#1C1917]"
      )} data-testid={testid}>{value}</dd>
    </div>
  );
}

function FormField({ label, icon, children }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-stone-500">
        {icon}{label}
      </label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

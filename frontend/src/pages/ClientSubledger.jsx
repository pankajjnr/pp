import { useEffect, useMemo, useState } from "react";
import { Users, Check, ChevronsUpDown, Package, FileDown, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * MODULE 2 — CLIENT SUBLEDGER (STANDALONE)
 * Pick a client → chronological log of procurement, filterable by product.
 * Export a product-wise PDF for any date range.
 */
export default function ClientSubledger() {
  const todayIso = toIsoDate(new Date());

  const [clients, setClients] = useState([]);
  const [products, setProducts] = useState([]);
  const [clientId, setClientId] = useState("");
  const [productFilter, setProductFilter] = useState(""); // "" = all
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [popOpen, setPopOpen] = useState(false);

  // PDF export dialog
  const [exportOpen, setExportOpen] = useState(false);
  const [fromDate, setFromDate] = useState(toIsoDate(new Date(Date.now() - 30 * 86400000)));
  const [toDate, setToDate] = useState(todayIso);
  const [downloading, setDownloading] = useState(false);

  const selectedClient = clients.find((c) => c.id === clientId);

  useEffect(() => {
    Promise.all([
      api.get("/clients"),
      api.get("/procurement/products"),
    ])
      .then(([c, p]) => { setClients(c.data || []); setProducts(p.data || []); })
      .catch((e) => toast.error(formatApiError(e)));
  }, []);

  useEffect(() => {
    if (!clientId) { setEntries([]); return; }
    setLoading(true);
    const qs = new URLSearchParams({ client_id: clientId });
    if (productFilter) qs.append("product_id", productFilter);
    api.get(`/procurement/entries?${qs.toString()}`)
      .then((r) => setEntries(r.data || []))
      .catch((e) => toast.error(formatApiError(e)))
      .finally(() => setLoading(false));
  }, [clientId, productFilter]);

  const sorted = useMemo(() =>
    [...entries].sort((a, b) =>
      a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at)
    ), [entries]);

  const totals = useMemo(() => ({
    weight: sorted.reduce((s, r) => s + Number(r.weight || 0), 0),
    amount: sorted.reduce((s, r) => s + Number(r.total_amount || 0), 0),
  }), [sorted]);

  const downloadPdf = async () => {
    if (!clientId) return;
    if (!fromDate || !toDate) return toast.error("Choose both dates");
    if (fromDate > toDate) return toast.error("From-date must be on or before to-date");
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (productFilter) qs.append("product_id", productFilter);
      const res = await api.get(`/procurement/clients/${clientId}/export?${qs.toString()}`, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      const productName = productFilter
        ? products.find((p) => p.id === productFilter)?.name || "product"
        : "all";
      a.download = `subledger_${selectedClient?.name?.replace(/\s+/g, "_") || "client"}_${productName}_${fromDate}_${toDate}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success("PDF downloaded");
      setExportOpen(false);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="client-subledger-page">
      <header className="flex items-baseline justify-between border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">Module 02</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="client-subledger-title">Client Subledger</h1>
          <p className="text-sm text-stone-500 mt-1">Every kilogram bought from a single hand — in order.</p>
        </div>
        {selectedClient && (
          <span className="font-mono text-xs uppercase tracking-widest text-stone-500">
            {sorted.length} procurement rows
          </span>
        )}
      </header>

      {/* Client picker */}
      <section className="bg-white border border-[#E7E5E4] p-5 space-y-4">
        <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
          <Users strokeWidth={1.5} className="w-3.5 h-3.5" /> Choose a client
        </label>
        <Popover open={popOpen} onOpenChange={setPopOpen}>
          <PopoverTrigger asChild>
            <button type="button" data-testid="subledger-client-trigger"
              className="w-full md:w-96 flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-lg focus:outline-none focus:border-[#292524]">
              <span className={cn(!selectedClient && "text-stone-400")}>
                {selectedClient ? formatClientName(selectedClient.name) : "Select a client to view subledger…"}
              </span>
              <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
            <Command>
              <CommandInput placeholder="Search client…" data-testid="subledger-client-search" />
              <CommandList>
                <CommandEmpty>No clients found.</CommandEmpty>
                <CommandGroup>
                  {clients.map((c) => (
                    <CommandItem key={c.id} value={c.name}
                      onSelect={() => { setClientId(c.id); setPopOpen(false); }}
                      data-testid={`subledger-client-opt-${c.id}`}>
                      <Check className={cn("mr-2 h-4 w-4", clientId === c.id ? "opacity-100" : "opacity-0")} />
                      {formatClientName(c.name)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </section>

      {selectedClient && (
        <>
          {/* Filter + export toolbar */}
          <div className="flex flex-wrap items-center gap-3" data-testid="subledger-toolbar">
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
              <Package strokeWidth={1.5} className="w-3.5 h-3.5" /> Product filter
            </label>
            <button type="button"
              onClick={() => setProductFilter("")}
              data-testid="subledger-product-all"
              className={cn(
                "px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors",
                productFilter === "" ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                                     : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
              )}>
              All Products
            </button>
            {products.map((p) => (
              <button key={p.id} type="button"
                onClick={() => setProductFilter(p.id)}
                data-testid={`subledger-product-${p.id}`}
                className={cn(
                  "px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors",
                  productFilter === p.id ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                                         : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
                )}>
                {p.name}
              </button>
            ))}

            <button onClick={() => setExportOpen(true)}
              data-testid="subledger-download-btn"
              className="ml-auto inline-flex items-center gap-2 border border-[#292524] text-[#292524] px-4 py-1.5 text-xs uppercase tracking-widest hover:bg-[#292524] hover:text-white transition-colors">
              <FileDown strokeWidth={1.5} className="w-3.5 h-3.5" />
              Download PDF
            </button>
          </div>

          {/* Table */}
          <section className="bg-white border border-[#E7E5E4]" data-testid="subledger-panel">
            <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center justify-between">
              <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold" data-testid="subledger-heading">
                Subledger — {formatClientName(selectedClient.name)}
                {productFilter && (
                  <span className="ml-2 text-xs text-stone-500 normal-case font-normal">
                    · {products.find((p) => p.id === productFilter)?.name}
                  </span>
                )}
              </h2>
              <span className="text-xs text-stone-500 font-mono">
                {loading ? "Loading…" : `${sorted.length} rows`}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="subledger-table">
                <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">#</th>
                    <th className="text-left px-5 py-3 font-medium">Date</th>
                    <th className="text-left px-5 py-3 font-medium">Product</th>
                    <th className="text-right px-5 py-3 font-medium">Weight (Qtl)</th>
                    <th className="text-right px-5 py-3 font-medium">Rate (₹/Qtl)</th>
                    <th className="text-right px-5 py-3 font-medium">Total Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {sorted.length === 0 && !loading ? (
                    <tr><td colSpan={6} className="text-center py-10 text-stone-500 italic">
                      No procurement entries for this client
                      {productFilter && " under this product"}.
                    </td></tr>
                  ) : sorted.map((r, i) => (
                    <tr key={r.id} className="hover:bg-[#FAFAF9]" data-testid={`subledger-row-${r.id}`}>
                      <td className="px-5 py-3 font-mono text-stone-400 text-[13px]">{String(i + 1).padStart(2, "0")}</td>
                      <td className="px-5 py-3 font-mono text-[13px]">{formatDate(r.entry_date)}</td>
                      <td className="px-5 py-3">{r.product_name}</td>
                      <td className="px-5 py-3 text-right font-mono">{r.weight.toLocaleString("en-IN")}</td>
                      <td className="px-5 py-3 text-right font-mono">{formatCurrency(r.rate)}</td>
                      <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(r.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
                {sorted.length > 0 && (
                  <tfoot className="bg-[#FAFAF9] border-t-2 border-[#78716C] text-[#1C1917]">
                    <tr data-testid="subledger-totals-row">
                      <td colSpan={3} className="px-5 py-3 text-[11px] uppercase tracking-widest text-stone-500">Totals</td>
                      <td className="px-5 py-3 text-right font-mono font-semibold" data-testid="subledger-total-weight">
                        {totals.weight.toLocaleString("en-IN")}
                      </td>
                      <td></td>
                      <td className="px-5 py-3 text-right font-mono font-semibold" data-testid="subledger-total-amount">
                        {formatCurrency(totals.amount)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>
        </>
      )}

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="export-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">Download Product-wise PDF</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              {selectedClient && <>For <strong>{formatClientName(selectedClient.name)}</strong> · </>}
              {productFilter
                ? <>Product: <strong>{products.find((p) => p.id === productFilter)?.name}</strong></>
                : <>All products</>}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div>
              <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
                <CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" /> From
              </label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                max={todayIso} data-testid="export-from-input"
                className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
                <CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" /> To
              </label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                max={todayIso} data-testid="export-to-input"
                className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
            </div>
          </div>
          <DialogFooter className="gap-2 pt-4">
            <button onClick={() => setExportOpen(false)} data-testid="export-cancel-btn"
              className="border border-[#D6D3D1] text-[#292524] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#F0EFEA]">
              Cancel
            </button>
            <button onClick={downloadPdf} disabled={downloading} data-testid="export-confirm-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-60 inline-flex items-center gap-2">
              <FileDown strokeWidth={1.5} className="w-4 h-4" />
              {downloading ? "Preparing…" : "Download PDF"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Plus, Package, Scale, IndianRupee, CalendarDays, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * MODULE 1 — STANDALONE PROCUREMENT LOG
 * Columns: Date, Client Name, Product, Weight, Rate, Total Amount
 * Client & Product are dropdowns from master lists. Total is read-only (weight × rate).
 */
export default function ProcurementLog() {
  const todayIso = toIsoDate(new Date());

  const [clients, setClients] = useState([]);
  const [products, setProducts] = useState([]);
  const [entries, setEntries] = useState([]);
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

  const totalAmount = useMemo(() => {
    const w = parseFloat(weight);
    const r = parseFloat(rate);
    if (isNaN(w) || isNaN(r)) return 0;
    return +(w * r).toFixed(2);
  }, [weight, rate]);

  const selectedClient = clients.find((c) => c.id === clientId);
  const selectedProduct = products.find((p) => p.id === productId);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cRes, pRes, eRes] = await Promise.all([
        api.get("/clients"),
        api.get("/procurement/products"),
        api.get("/procurement/entries"),
      ]);
      setClients(cRes.data || []);
      setProducts(pRes.data || []);
      setEntries(eRes.data || []);
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

  const submit = async (e) => {
    e.preventDefault();
    if (!clientId) return toast.error("Select a client");
    if (!productId) return toast.error("Select a product");
    if (!weight || Number(weight) <= 0) return toast.error("Weight must be > 0");
    if (!rate || Number(rate) <= 0) return toast.error("Rate must be > 0");
    setSaving(true);
    try {
      await api.post("/procurement/entries", {
        entry_date: entryDate,
        client_id: clientId,
        product_id: productId,
        weight: Number(weight),
        rate: Number(rate),
      });
      toast.success("Procurement entry saved");
      resetForm();
      // reload entries only
      const eRes = await api.get("/procurement/entries");
      setEntries(eRes.data || []);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="procurement-log-page">
      {/* Header */}
      <header className="flex items-baseline justify-between border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">Module 01</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="procurement-log-title">Procurement Log</h1>
          <p className="text-sm text-stone-500 mt-1">Weight × Rate — every kilogram, every rupee, recorded once.</p>
        </div>
        <span className="font-mono text-xs uppercase tracking-widest text-stone-500">
          {entries.length} entries
        </span>
      </header>

      {/* Entry Form */}
      <form onSubmit={submit} data-testid="procurement-form" className="bg-white border border-[#E7E5E4] p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-5">
          {/* Date */}
          <FormField label="Date" icon={<CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
              max={todayIso} data-testid="procurement-date-input" required
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </FormField>

          {/* Client dropdown */}
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

          {/* Product dropdown */}
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
                    <CommandEmpty>No products in master list.</CommandEmpty>
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

          {/* Weight */}
          <FormField label="Weight (kg)" icon={<Scale strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="number" step="0.01" min="0" value={weight} onChange={(e) => setWeight(e.target.value)}
              placeholder="0.00" required data-testid="procurement-weight-input"
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </FormField>

          {/* Rate */}
          <FormField label="Rate (₹/kg)" icon={<IndianRupee strokeWidth={1.5} className="w-3.5 h-3.5" />}>
            <input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder="0.00" required data-testid="procurement-rate-input"
              className="w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </FormField>
        </div>

        {/* Total row + submit */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end justify-between gap-4 pt-3 border-t border-dashed border-[#E7E5E4]">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-stone-500">Total Amount (read-only)</div>
            <div className="mt-1 font-mono text-3xl text-[#1C1917]" data-testid="procurement-total-amount">
              {formatCurrency(totalAmount)}
            </div>
            <div className="text-[11px] font-mono text-stone-400 mt-0.5">= weight × rate</div>
          </div>
          <button type="submit" disabled={saving} data-testid="procurement-submit-btn"
            className="inline-flex items-center gap-2 bg-[#292524] text-[#FAFAF9] px-6 py-3 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-60 transition-colors">
            <Plus strokeWidth={1.5} className="w-4 h-4" />
            {saving ? "Saving…" : "Log Entry"}
          </button>
        </div>
      </form>

      {/* Entries table */}
      <section className="bg-white border border-[#E7E5E4]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E7E5E4]">
          <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold flex items-center gap-2">
            <Package strokeWidth={1.5} className="w-4 h-4" /> Procurement Log
          </h2>
          <span className="text-xs text-stone-500 font-mono">{loading ? "Loading…" : `${entries.length} rows`}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="procurement-table">
            <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Date</th>
                <th className="text-left px-5 py-3 font-medium">Client Name</th>
                <th className="text-left px-5 py-3 font-medium">Product</th>
                <th className="text-right px-5 py-3 font-medium">Weight (kg)</th>
                <th className="text-right px-5 py-3 font-medium">Rate (₹/kg)</th>
                <th className="text-right px-5 py-3 font-medium">Total Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E5E4]">
              {entries.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-stone-500 italic">No entries yet. Log your first purchase above.</td></tr>
              ) : entries.map((r) => (
                <tr key={r.id} className="hover:bg-[#FAFAF9]" data-testid={`procurement-row-${r.id}`}>
                  <td className="px-5 py-3 font-mono text-[13px]">{formatDate(r.entry_date)}</td>
                  <td className="px-5 py-3">{formatClientName(r.client_name)}</td>
                  <td className="px-5 py-3">{r.product_name}</td>
                  <td className="px-5 py-3 text-right font-mono">{r.weight.toLocaleString("en-IN")}</td>
                  <td className="px-5 py-3 text-right font-mono">{formatCurrency(r.rate)}</td>
                  <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(r.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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

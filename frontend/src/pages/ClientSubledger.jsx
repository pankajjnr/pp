import { useEffect, useMemo, useState } from "react";
import { Users, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * MODULE 2 — CLIENT SUBLEDGER (STANDALONE)
 * Pick a client → chronological log of all material procured from that client.
 * No balance / no financial integration by design.
 */
export default function ClientSubledger() {
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [popOpen, setPopOpen] = useState(false);

  const selectedClient = clients.find((c) => c.id === clientId);

  useEffect(() => {
    api.get("/clients").then((r) => setClients(r.data || [])).catch((e) => toast.error(formatApiError(e)));
  }, []);

  useEffect(() => {
    if (!clientId) { setEntries([]); return; }
    setLoading(true);
    api.get(`/procurement/entries?client_id=${clientId}`)
      .then((r) => setEntries(r.data || []))
      .catch((e) => toast.error(formatApiError(e)))
      .finally(() => setLoading(false));
  }, [clientId]);

  // Sort chronologically ascending (oldest first) for a ledger feel
  const sorted = useMemo(() => {
    return [...entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at));
  }, [entries]);

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
            {entries.length} procurement rows
          </span>
        )}
      </header>

      {/* Client picker */}
      <section className="bg-white border border-[#E7E5E4] p-5">
        <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
          <Users strokeWidth={1.5} className="w-3.5 h-3.5" /> Choose a client
        </label>
        <Popover open={popOpen} onOpenChange={setPopOpen}>
          <PopoverTrigger asChild>
            <button type="button" data-testid="subledger-client-trigger"
              className="mt-2 w-full md:w-96 flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-lg focus:outline-none focus:border-[#292524]">
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

      {/* Table */}
      {selectedClient && (
        <section className="bg-white border border-[#E7E5E4]" data-testid="subledger-panel">
          <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold" data-testid="subledger-heading">
              Subledger — {formatClientName(selectedClient.name)}
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
                    No procurement entries for this client yet.
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
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

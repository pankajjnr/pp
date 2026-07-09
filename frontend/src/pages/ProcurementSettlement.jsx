import { useEffect, useMemo, useState } from "react";
import {
  Wallet, Check, ChevronsUpDown, CalendarDays, Percent, Receipt, History,
  AlertTriangle, Package, ListChecks,
} from "lucide-react";
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

const PRESETS = [
  { key: "1", label: "1 %", value: 1 },
  { key: "1.5", label: "1.5 %", value: 1.5 },
];

/**
 * MODULE — Procurement Payment Settlement (explicit date-range model).
 * Auto-posts the settlement to the existing Client Subledger as an
 * outgoing payment. Marks every included procurement entry as settled
 * so it can never be double-paid, regardless of overlapping ranges.
 */
export default function ProcurementSettlement() {
  const todayIso = toIsoDate(new Date());

  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [clientOpen, setClientOpen] = useState(false);

  const [fromDate, setFromDate] = useState(todayIso);
  const [toDate, setToDate] = useState(todayIso);

  const [dedKey, setDedKey] = useState("1");
  const [customPct, setCustomPct] = useState("");

  const [preview, setPreview] = useState(null); // OutstandingPreview
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [settlements, setSettlements] = useState([]);
  const [lastSettlement, setLastSettlement] = useState(null); // {from_date,to_date,created_at} | null
  const [receipt, setReceipt] = useState(null);

  const selectedClient = clients.find((c) => c.id === clientId);

  const deductionPercent = useMemo(() => {
    if (dedKey === "custom") {
      const v = parseFloat(customPct);
      if (isNaN(v) || v < 0 || v > 100) return null;
      return v;
    }
    return PRESETS.find((p) => p.key === dedKey)?.value ?? 0;
  }, [dedKey, customPct]);

  const previewMath = useMemo(() => {
    if (!preview || deductionPercent === null) return null;
    const gross = Number(preview.gross_amount || 0);
    const deduction = +(gross * deductionPercent / 100).toFixed(2);
    const net = +(gross - deduction).toFixed(2);
    return { gross, deduction, net };
  }, [preview, deductionPercent]);

  useEffect(() => {
    api.get("/clients")
      .then((r) => setClients(r.data || []))
      .catch((e) => toast.error(formatApiError(e)));
  }, []);

  const loadClientContext = async (cid) => {
    if (!cid) { setSettlements([]); setLastSettlement(null); return; }
    try {
      const [hist, last] = await Promise.all([
        api.get(`/procurement/settlements?client_id=${cid}`),
        api.get(`/procurement/clients/${cid}/last-settlement`),
      ]);
      setSettlements(hist.data || []);
      setLastSettlement(last.data || null);
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  useEffect(() => {
    setPreview(null);
    loadClientContext(clientId);
  }, [clientId]);

  const runPreview = async () => {
    if (!clientId) return toast.error("Select a client");
    if (!fromDate || !toDate) return toast.error("Choose a from-date and to-date");
    if (fromDate > toDate) return toast.error("From-date must be on or before to-date");
    if (deductionPercent === null) return toast.error("Enter a valid deduction % (0–100)");
    setLoadingPreview(true);
    setPreview(null);
    try {
      const r = await api.get(
        `/procurement/clients/${clientId}/outstanding?from_date=${fromDate}&to_date=${toDate}`
      );
      setPreview(r.data);
      if (r.data.entry_count === 0) toast.info("No unsettled entries in this range.");
    } catch (e) {
      toast.error(formatApiError(e));
    } finally {
      setLoadingPreview(false);
    }
  };

  const confirmSettle = async () => {
    if (!preview || preview.entry_count === 0) return toast.error("Nothing to settle");
    if (deductionPercent === null) return toast.error("Enter a valid deduction %");
    setConfirming(true);
    try {
      const r = await api.post("/procurement/settlements", {
        client_id: clientId,
        from_date: fromDate,
        to_date: toDate,
        deduction_percent: deductionPercent,
      });
      setReceipt(r.data);
      setPreview(null);
      await loadClientContext(clientId);
      toast.success("Settlement recorded — posted to subledger");
    } catch (e) {
      toast.error(formatApiError(e));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="procurement-settlement-page">
      <header className="flex items-baseline justify-between border-b border-[#E7E5E4] pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-stone-500">Module 04</div>
          <h1 className="mt-1 text-3xl font-serif text-[#1C1917]" data-testid="settlement-title">Payment Settlement</h1>
          <p className="text-sm text-stone-500 mt-1">
            Pay a client for procurement in a specific date range. Auto-posted to the client&apos;s subledger.
          </p>
        </div>
      </header>

      {/* Setup */}
      <section className="bg-white border border-[#E7E5E4] p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* Client */}
          <div className="md:col-span-1">
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
              <Wallet strokeWidth={1.5} className="w-3.5 h-3.5" /> Client
            </label>
            <Popover open={clientOpen} onOpenChange={setClientOpen}>
              <PopoverTrigger asChild>
                <button type="button" data-testid="settlement-client-trigger"
                  className="mt-2 w-full flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524]">
                  <span className={cn(!selectedClient && "text-stone-400")}>
                    {selectedClient ? formatClientName(selectedClient.name) : "Select client…"}
                  </span>
                  <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
                <Command>
                  <CommandInput placeholder="Search client…" data-testid="settlement-client-search" />
                  <CommandList>
                    <CommandEmpty>No clients found.</CommandEmpty>
                    <CommandGroup>
                      {clients.map((c) => (
                        <CommandItem key={c.id} value={c.name}
                          onSelect={() => { setClientId(c.id); setClientOpen(false); }}
                          data-testid={`settlement-client-opt-${c.id}`}>
                          <Check className={cn("mr-2 h-4 w-4", clientId === c.id ? "opacity-100" : "opacity-0")} />
                          {formatClientName(c.name)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* From */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
              <CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" /> From date
            </label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              max={todayIso} data-testid="settlement-from-input"
              className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </div>

          {/* To */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
              <CalendarDays strokeWidth={1.5} className="w-3.5 h-3.5" /> To date
            </label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              max={todayIso} data-testid="settlement-to-input"
              className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-sm focus:outline-none focus:border-[#292524]" />
          </div>

          {/* Deduction */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-stone-500 flex items-center gap-1.5">
              <Percent strokeWidth={1.5} className="w-3.5 h-3.5" /> Deduction %
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" onClick={() => setDedKey(p.key)}
                  data-testid={`ded-preset-${p.key}`}
                  className={cn(
                    "px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors",
                    dedKey === p.key ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                                     : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
                  )}>
                  {p.label}
                </button>
              ))}
              <button type="button" onClick={() => setDedKey("custom")}
                data-testid="ded-preset-custom"
                className={cn(
                  "px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors",
                  dedKey === "custom" ? "bg-[#292524] text-[#FAFAF9] border-[#292524]"
                                      : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
                )}>
                Custom
              </button>
            </div>
            {dedKey === "custom" && (
              <div className="mt-3 flex items-baseline gap-2 border-b border-[#D6D3D1]">
                <input type="number" step="0.01" min="0" max="100" value={customPct}
                  onChange={(e) => setCustomPct(e.target.value)}
                  data-testid="ded-custom-input" placeholder="0"
                  className="flex-1 bg-transparent py-2 font-mono text-lg focus:outline-none placeholder-stone-300" />
                <span className="text-stone-500 text-sm">%</span>
              </div>
            )}
          </div>
        </div>

        {/* Reference line */}
        {selectedClient && (
          <div className="text-xs text-stone-500 font-mono flex items-center gap-2 pt-1" data-testid="last-settlement-ref">
            <History strokeWidth={1.5} className="w-3.5 h-3.5" />
            {lastSettlement
              ? <>Last settled: <span className="text-[#1C1917]">{formatDate(lastSettlement.from_date)} → {formatDate(lastSettlement.to_date)}</span> (informational only)</>
              : <>No settlements yet for this client.</>}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-dashed border-[#E7E5E4]">
          <button onClick={runPreview} disabled={loadingPreview || !clientId}
            data-testid="preview-btn"
            className="inline-flex items-center gap-2 border border-[#292524] text-[#292524] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#292524] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[#292524] transition-colors">
            <ListChecks strokeWidth={1.5} className="w-4 h-4" />
            {loadingPreview ? "Loading…" : "Show Entries"}
          </button>

          <button onClick={confirmSettle}
            disabled={!preview || preview.entry_count === 0 || confirming || deductionPercent === null}
            data-testid="confirm-settle-btn"
            className="inline-flex items-center gap-2 bg-[#292524] text-[#FAFAF9] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Check strokeWidth={1.5} className="w-4 h-4" />
            {confirming ? "Settling…" : "Confirm & Settle"}
          </button>

          {selectedClient && (
            <span className="text-xs text-stone-500 font-mono ml-auto" data-testid="context-summary">
              {formatClientName(selectedClient.name)} · {formatDate(fromDate)} → {formatDate(toDate)}
              {deductionPercent !== null && ` · ${deductionPercent}%`}
            </span>
          )}
        </div>
      </section>

      {/* Preview */}
      {preview && (
        <PreviewPanel preview={preview} math={previewMath} deductionPercent={deductionPercent} />
      )}

      {/* Settlement history */}
      {selectedClient && (
        <section className="bg-white border border-[#E7E5E4]" data-testid="settlement-history-panel">
          <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold flex items-center gap-2">
              <History strokeWidth={1.5} className="w-4 h-4" />
              Settlement History — {formatClientName(selectedClient.name)}
            </h2>
            <span className="text-xs text-stone-500 font-mono">{settlements.length} settlements</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="settlement-history-table">
              <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                <tr>
                  <th className="text-left px-5 py-3 font-medium">Settled On</th>
                  <th className="text-left px-5 py-3 font-medium">From → To</th>
                  <th className="text-right px-5 py-3 font-medium">Entries</th>
                  <th className="text-right px-5 py-3 font-medium">Gross</th>
                  <th className="text-right px-5 py-3 font-medium">Ded.%</th>
                  <th className="text-right px-5 py-3 font-medium">Deduction</th>
                  <th className="text-right px-5 py-3 font-medium">Net Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E5E4]">
                {settlements.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-8 text-stone-500 italic">
                    No settlements recorded for this client yet.
                  </td></tr>
                ) : settlements.map((s) => (
                  <tr key={s.id} className="hover:bg-[#FAFAF9]" data-testid={`settlement-row-${s.id}`}>
                    <td className="px-5 py-3 font-mono text-[12px] text-stone-500">
                      {new Date(s.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-5 py-3 font-mono text-[12px]">
                      {formatDate(s.from_date)} → {formatDate(s.to_date)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono">{s.entry_count}</td>
                    <td className="px-5 py-3 text-right font-mono">{formatCurrency(s.gross_amount)}</td>
                    <td className="px-5 py-3 text-right font-mono">{s.deduction_percent}%</td>
                    <td className="px-5 py-3 text-right font-mono text-orange-800">− {formatCurrency(s.deduction_amount)}</td>
                    <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(s.net_paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Receipt */}
      <Dialog open={!!receipt} onOpenChange={(v) => !v && setReceipt(null)}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="receipt-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">Payment settled</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Posted to the client&apos;s subledger as an outgoing payment.
            </DialogDescription>
          </DialogHeader>
          {receipt && (
            <dl className="mt-2 divide-y divide-[#E7E5E4] border-y border-[#E7E5E4]">
              <RRow label="Client" value={formatClientName(receipt.client_name)} testid="receipt-client" />
              <RRow label="Material dated" value={`${formatDate(receipt.from_date)} → ${formatDate(receipt.to_date)}`} testid="receipt-window" mono />
              <RRow label="Entries" value={String(receipt.entry_count)} testid="receipt-count" mono />
              <RRow label="Gross" value={formatCurrency(receipt.gross_amount)} testid="receipt-gross" mono />
              <RRow label={`Deduction (${receipt.deduction_percent}%)`}
                value={`− ${formatCurrency(receipt.deduction_amount)}`}
                testid="receipt-deduction" mono />
              <RRow label="Net paid (posted)" value={formatCurrency(receipt.net_paid)} testid="receipt-net" mono emphasis />
            </dl>
          )}
          <DialogFooter className="pt-4">
            <button onClick={() => setReceipt(null)} data-testid="close-receipt-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
              Done
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PreviewPanel({ preview, math, deductionPercent }) {
  const empty = preview.entry_count === 0;
  return (
    <section className="space-y-6" data-testid="preview-panel">
      <div className="bg-white border border-[#E7E5E4] p-6">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-4">
          Outstanding · {formatClientName(preview.client_name)} · <span className="font-mono">{formatDate(preview.from_date)} → {formatDate(preview.to_date)}</span>
        </div>

        {empty ? (
          <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 p-4 text-sm text-orange-900" data-testid="preview-empty">
            <AlertTriangle strokeWidth={1.5} className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              No unsettled procurement entries between <strong>{formatDate(preview.from_date)}</strong> and <strong>{formatDate(preview.to_date)}</strong>. Nothing to settle.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <Stat label="Unpaid entries" value={String(preview.entry_count)} testid="preview-count" mono />
            <Stat label="Gross amount" value={formatCurrency(math.gross)} testid="preview-gross" mono />
            <Stat label={`Deduction (${deductionPercent}%)`} value={`− ${formatCurrency(math.deduction)}`} testid="preview-deduction" mono tone="orange" />
            <Stat label="Net payable" value={formatCurrency(math.net)} testid="preview-net" mono emphasis />
          </div>
        )}
      </div>

      {!empty && (
        <>
          {/* Product subtotals */}
          <div className="bg-white border border-[#E7E5E4]" data-testid="preview-subtotals">
            <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center gap-2">
              <Package strokeWidth={1.5} className="w-4 h-4 text-[#1C1917]" />
              <h3 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold">Product-wise Subtotals</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">Product</th>
                    <th className="text-right px-5 py-3 font-medium">Entries</th>
                    <th className="text-right px-5 py-3 font-medium">Total Weight (Qtl)</th>
                    <th className="text-right px-5 py-3 font-medium">Total Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {preview.subtotals.map((s) => (
                    <tr key={s.product_id} data-testid={`subtotal-${s.product_id}`}>
                      <td className="px-5 py-3">{s.product_name}</td>
                      <td className="px-5 py-3 text-right font-mono">{s.entry_count}</td>
                      <td className="px-5 py-3 text-right font-mono">{s.total_weight.toLocaleString("en-IN")}</td>
                      <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(s.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Every eligible entry */}
          <div className="bg-white border border-[#E7E5E4]" data-testid="preview-entries">
            <div className="px-5 py-3 border-b border-[#E7E5E4] flex items-center justify-between">
              <h3 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold flex items-center gap-2">
                <ListChecks strokeWidth={1.5} className="w-4 h-4" />
                Eligible Entries
              </h3>
              <span className="text-xs text-stone-500 font-mono">{preview.entries.length} rows</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">Date</th>
                    <th className="text-left px-5 py-3 font-medium">Product</th>
                    <th className="text-right px-5 py-3 font-medium">Weight (Qtl)</th>
                    <th className="text-right px-5 py-3 font-medium">Rate</th>
                    <th className="text-right px-5 py-3 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E5E4]">
                  {preview.entries.map((e) => (
                    <tr key={e.id} className="hover:bg-[#FAFAF9]" data-testid={`preview-row-${e.id}`}>
                      <td className="px-5 py-3 font-mono text-[12px]">{formatDate(e.entry_date)}</td>
                      <td className="px-5 py-3">{e.product_name}</td>
                      <td className="px-5 py-3 text-right font-mono">{e.weight.toLocaleString("en-IN")}</td>
                      <td className="px-5 py-3 text-right font-mono">{formatCurrency(e.rate)}</td>
                      <td className="px-5 py-3 text-right font-mono font-semibold">{formatCurrency(e.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, testid, mono, emphasis, tone }) {
  const toneColor = tone === "orange" ? "text-orange-800" : "text-[#1C1917]";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={cn(
        "mt-1 text-2xl",
        mono ? "font-mono" : "font-serif",
        emphasis ? "text-3xl font-semibold" : "",
        toneColor,
      )} data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

function RRow({ label, value, testid, mono, emphasis }) {
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

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronsUpDown } from "lucide-react";
import api, { formatCurrency, formatApiError, formatDate } from "@/lib/api";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export default function AddPayment() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [direction, setDirection] = useState("out"); // default: money going out
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/clients").then((r) => setClients(r.data)).catch((e) => toast.error(formatApiError(e)));
  }, []);

  const selectedClient = clients.find((c) => c.id === selectedId);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!selectedId) return toast.error("Please choose a client");
    if (!amount || Number(amount) <= 0) return toast.error("Amount must be greater than zero");
    setShowConfirm(true);
  };

  const confirm = async () => {
    setSaving(true);
    try {
      await api.post("/payments", {
        client_id: selectedId,
        direction,
        amount: Number(amount),
        description,
        entry_date: entryDate,
      });
      toast.success("Entry saved to the ledger");
      // No auto-navigate — reset form so user can add another entry
      setSelectedId("");
      setAmount("");
      setDescription("");
      setDirection("out");
      setEntryDate(new Date().toISOString().slice(0, 10));
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setSaving(false);
      setShowConfirm(false);
    }
  };

  const isIn = direction === "in";

  return (
    <div className="max-w-2xl mx-auto space-y-10" data-testid="add-payment-page">
      <div>
        <div className="text-xs uppercase tracking-[0.25em] text-stone-500">New Entry</div>
        <h1 className="font-serif text-4xl sm:text-5xl tracking-tight text-[#1C1917] mt-2">Write it down.</h1>
        <p className="text-stone-500 mt-3">Every rupee, remembered for good.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-[#E7E5E4] shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] p-6 sm:p-10 space-y-8" data-testid="add-payment-form">
        {/* Client */}
        <div>
          <label className="text-xs uppercase tracking-widest text-stone-500">Client</label>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                role="combobox"
                data-testid="client-select-trigger"
                className="mt-2 w-full flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-lg focus:outline-none focus:border-[#292524]"
              >
                <span className={cn(!selectedClient && "text-stone-400")}>
                  {selectedClient ? selectedClient.name : "Search and choose a client…"}
                </span>
                <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
              <Command>
                <CommandInput placeholder="Type a name…" data-testid="client-select-search" />
                <CommandList>
                  <CommandEmpty>No clients found. Add one first.</CommandEmpty>
                  <CommandGroup>
                    {clients.map((c) => (
                      <CommandItem
                        key={c.id}
                        value={c.name}
                        onSelect={() => { setSelectedId(c.id); setOpen(false); }}
                        data-testid={`client-option-${c.id}`}
                      >
                        <Check className={cn("mr-2 h-4 w-4", selectedId === c.id ? "opacity-100" : "opacity-0")} />
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {/* Direction toggle */}
        <div>
          <label className="text-xs uppercase tracking-widest text-stone-500">Direction</label>
          <div className="mt-2 grid grid-cols-2 border border-[#D6D3D1]">
            <button
              type="button"
              onClick={() => setDirection("in")}
              data-testid="direction-in-btn"
              className={cn(
                "flex items-center justify-center gap-2 py-3 transition-colors",
                isIn ? "bg-emerald-50 text-emerald-900 border-r border-emerald-200" : "text-stone-500 hover:bg-[#F0EFEA] border-r border-[#D6D3D1]"
              )}
            >
              <ArrowDownLeft strokeWidth={1.5} className="w-4 h-4" /> Money Coming In
            </button>
            <button
              type="button"
              onClick={() => setDirection("out")}
              data-testid="direction-out-btn"
              className={cn(
                "flex items-center justify-center gap-2 py-3 transition-colors",
                !isIn ? "bg-orange-50 text-orange-900" : "text-stone-500 hover:bg-[#F0EFEA]"
              )}
            >
              <ArrowUpRight strokeWidth={1.5} className="w-4 h-4" /> Money Going Out
            </button>
          </div>
        </div>

        {/* Amount */}
        <div>
          <label className="text-xs uppercase tracking-widest text-stone-500">Amount</label>
          <div className="mt-2 flex items-baseline gap-3 border-b border-[#D6D3D1]">
            <span className="font-mono text-3xl text-stone-500">₹</span>
            <input
              type="number" step="0.01" min="0" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required data-testid="amount-input"
              placeholder="0"
              className="flex-1 bg-transparent py-2 font-mono text-3xl focus:outline-none placeholder-stone-300"
            />
          </div>
        </div>

        {/* Date */}
        <div>
          <label className="text-xs uppercase tracking-widest text-stone-500">Date</label>
          <input
            type="date" value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
            data-testid="entry-date-input"
            className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono text-lg focus:outline-none focus:border-[#292524]"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs uppercase tracking-widest text-stone-500">Description <span className="text-stone-400 normal-case tracking-normal ml-1">(optional)</span></label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="description-input"
            placeholder="e.g. Loan repayment, advance…"
            className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 focus:outline-none focus:border-[#292524]" />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate(-1)} data-testid="cancel-payment-btn"
            className="border border-[#D6D3D1] px-5 py-3 text-sm hover:bg-[#F0EFEA]">Cancel</button>
          <button type="submit" data-testid="review-entry-btn"
            className="bg-[#292524] text-[#FAFAF9] px-6 py-3 uppercase tracking-widest text-xs hover:bg-[#1C1917]">
            Review entry
          </button>
        </div>
      </form>

      {/* Confirmation */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm" data-testid="confirmation-dialog">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Confirm this entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
              <div className="text-stone-500 uppercase tracking-widest text-xs">Client</div>
              <div className="text-right font-medium">{selectedClient?.name}</div>
              <div className="text-stone-500 uppercase tracking-widest text-xs">Direction</div>
              <div className={cn("text-right font-medium", isIn ? "text-emerald-800" : "text-orange-800")}>
                {isIn ? "Money Coming In" : "Money Going Out"}
              </div>
              <div className="text-stone-500 uppercase tracking-widest text-xs">Date</div>
              <div className="text-right font-mono">{formatDate(entryDate)}</div>
              {description && <>
                <div className="text-stone-500 uppercase tracking-widest text-xs">Note</div>
                <div className="text-right text-stone-600 italic">"{description}"</div>
              </>}
            </div>
            <div className={cn("border-t border-[#D6D3D1] pt-4 text-center", isIn ? "text-emerald-800" : "text-orange-800")}>
              <div className="text-xs uppercase tracking-widest">Amount</div>
              <div className="font-mono text-5xl mt-2" data-testid="confirm-amount">
                {isIn ? "+" : "−"}{formatCurrency(amount)}
              </div>
            </div>
            <p className="text-xs text-stone-500 text-center italic">Once confirmed, this entry cannot be altered.</p>
          </div>
          <DialogFooter className="gap-2">
            <button onClick={() => setShowConfirm(false)} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-confirm-btn">Go back</button>
            <button onClick={confirm} disabled={saving} data-testid="confirm-save-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-60">
              {saving ? "Saving…" : "Confirm & save"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

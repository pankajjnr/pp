import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Plus, Calculator, Check, ChevronsUpDown, Wheat, IndianRupee, Wallet } from "lucide-react";
import api, { formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { Calendar } from "@/components/ui/calendar";
import { toast } from "sonner";
import { useLang } from "@/context/LangContext";
import StatCard from "@/components/StatCard";
import usePageTitle from "@/hooks/usePageTitle";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function AddPaymentModal({ open, onOpenChange, onSaved, defaultDate }) {
  const { t, lang } = useLang();
  const serif = lang === "hi" ? "" : "font-serif";
  const [clients, setClients] = useState([]);
  const [popOpen, setPopOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [direction, setDirection] = useState("out");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEntryDate(defaultDate);
      api.get("/clients").then((r) => setClients(r.data)).catch(() => {});
    } else {
      setSelectedId(""); setAmount(""); setDescription(""); setDirection("out");
    }
  }, [open, defaultDate]);

  const selectedClient = clients.find((c) => c.id === selectedId);
  const isIn = direction === "in";

  const submit = async (e) => {
    e.preventDefault();
    if (!selectedId) return toast.error(t("add.chooseClient"));
    if (!amount || Number(amount) <= 0) return toast.error(t("add.amountPositive"));
    setSaving(true);
    try {
      await api.post("/payments", {
        client_id: selectedId, direction, amount: Number(amount),
        description, entry_date: entryDate,
      });
      toast.success(t("add.savedToast"));
      onSaved && onSaved();
      onOpenChange(false);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-lg" data-testid="add-payment-modal">
        <DialogHeader><DialogTitle className={`text-2xl ${serif}`}>{t("add.modalTitle")}</DialogTitle>
          <DialogDescription className="sr-only">Add a new payment entry</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5" data-testid="add-payment-form">
          <div>
            <label className="text-xs uppercase tracking-widest text-stone-500">{t("add.client")}</label>
            <Popover open={popOpen} onOpenChange={setPopOpen}>
              <PopoverTrigger asChild>
                <button type="button" data-testid="client-select-trigger"
                  className="mt-2 w-full flex justify-between items-center bg-transparent border-b border-[#D6D3D1] py-2 text-lg focus:outline-none focus:border-[#292524]">
                  <span className={cn(!selectedClient && "text-stone-400")}>{selectedClient ? formatClientName(selectedClient.name) : t("add.clientPlaceholder")}</span>
                  <ChevronsUpDown strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[--radix-popover-trigger-width] bg-white border-[#E7E5E4]">
                <Command>
                  <CommandInput placeholder={t("add.searchType")} data-testid="client-select-search" />
                  <CommandList>
                    <CommandEmpty>{t("add.noClients")}</CommandEmpty>
                    <CommandGroup>
                      {clients.map((c) => (
                        <CommandItem key={c.id} value={c.name} onSelect={() => { setSelectedId(c.id); setPopOpen(false); }} data-testid={`client-option-${c.id}`}>
                          <Check className={cn("mr-2 h-4 w-4", selectedId === c.id ? "opacity-100" : "opacity-0")} />
                          {formatClientName(c.name)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div>
            <label className="text-xs uppercase tracking-widest text-stone-500">{t("add.direction")}</label>
            <div className="mt-2 grid grid-cols-2 border border-[#D6D3D1]">
              <button type="button" onClick={() => setDirection("in")} data-testid="direction-in-btn"
                className={cn("flex items-center justify-center gap-2 py-2.5 text-sm transition-colors",
                  isIn ? "bg-emerald-50 text-emerald-900 border-r border-emerald-200" : "text-stone-500 hover:bg-[#F0EFEA] border-r border-[#D6D3D1]")}>
                <ArrowDownLeft strokeWidth={1.5} className="w-4 h-4" /> {t("col.received")}
              </button>
              <button type="button" onClick={() => setDirection("out")} data-testid="direction-out-btn"
                className={cn("flex items-center justify-center gap-2 py-2.5 text-sm transition-colors",
                  !isIn ? "bg-orange-50 text-orange-900" : "text-stone-500 hover:bg-[#F0EFEA]")}>
                <ArrowUpRight strokeWidth={1.5} className="w-4 h-4" /> {t("col.given")}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs uppercase tracking-widest text-stone-500">{t("add.amount")}</label>
              <div className="mt-2 flex items-baseline gap-2 border-b border-[#D6D3D1]">
                <span className="font-mono text-2xl text-stone-500">₹</span>
                <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                  required data-testid="amount-input" placeholder="0"
                  className="flex-1 bg-transparent py-2 font-mono text-2xl focus:outline-none placeholder-stone-300 w-0" />
              </div>
            </div>
            <div>
              <label className="text-xs uppercase tracking-widest text-stone-500">{t("add.date")}</label>
              <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
                max={toIsoDate(new Date())} data-testid="entry-date-input"
                className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 font-mono focus:outline-none focus:border-[#292524]" />
            </div>
          </div>

          <div>
            <label className="text-xs uppercase tracking-widest text-stone-500">{t("add.description")} <span className="normal-case tracking-normal text-stone-400 ml-1">{t("add.optional")}</span></label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="description-input"
              placeholder={t("add.descPlaceholder")}
              className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 focus:outline-none focus:border-[#292524]" />
          </div>

          <DialogFooter className="gap-2 pt-2">
            <button type="button" onClick={() => onOpenChange(false)} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-payment-btn">{t("action.cancel")}</button>
            <button type="submit" disabled={saving} data-testid="submit-payment-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-60">
              {saving ? t("action.saving") : t("add.confirmSave")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PaymentColumn({ items, emptyMsg, tone, testid }) {
  const color = tone === "in" ? "text-emerald-800" : "text-orange-800";
  return (
    <div data-testid={testid}>
      {items.length === 0 ? (
        <div className="text-sm text-stone-500 italic py-8 text-center border border-dashed border-[#D6D3D1]">{emptyMsg}</div>
      ) : (
        <ul className="divide-y divide-[#E7E5E4]">
          {items.map((p) => (
            <li key={p.id} className="py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-[#1C1917] truncate text-sm">{formatClientName(p.client_name)}</div>
                {p.description && <div className="text-xs text-stone-500 truncate">{p.description}</div>}
              </div>
              <div className={`font-mono text-base ${color} whitespace-nowrap`}>{formatCurrency(p.amount)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { t, lang } = useLang();
  usePageTitle("nav.dailyLog", { isKey: true });
  const [activeDate, setActiveDate] = useState(new Date());
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showCalcConfirm, setShowCalcConfirm] = useState(false);
  const [showCalcResult, setShowCalcResult] = useState(false);
  const [calcTotals, setCalcTotals] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [focusColumn, setFocusColumn] = useState(null); // "in" | "out" | null

  // Dashboard-level stats (Edit 1 + Edit 7)
  const [todayProcurement, setTodayProcurement] = useState({ count: 0, weight: 0, cost: 0 });
  const [muddatBalance, setMuddatBalance] = useState(0);
  const [recentActivity, setRecentActivity] = useState([]);

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const activeDateStr = toIsoDate(activeDate);
  const todayStr = toIsoDate(new Date());
  const yesterdayStr = toIsoDate(new Date(Date.now() - 86400000));

  const fetchPayments = () => {
    setLoading(true);
    api.get(`/payments/by-date?date_str=${activeDateStr}`)
      .then((r) => setPayments(r.data))
      .catch((e) => toast.error(formatApiError(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPayments(); }, [activeDateStr]);

  // Load Dashboard-level stats + recent activity (once)
  useEffect(() => {
    const todayIso = toIsoDate(new Date());
    (async () => {
      try {
        const [procRes, clientsRes] = await Promise.all([
          api.get(`/procurement/entries?entry_date=${todayIso}`),
          api.get("/clients"),
        ]);
        const rows = procRes.data || [];
        setTodayProcurement({
          count: rows.length,
          weight: rows.reduce((s, r) => s + Number(r.weight || 0), 0),
          cost: rows.reduce((s, r) => s + Number(r.total_amount || 0), 0),
        });
        const muddat = (clientsRes.data || []).find(
          (c) => (c.name || "").toLowerCase() === "muddat"
        );
        if (muddat) {
          try {
            const led = await api.get(`/clients/${muddat.id}/ledger`);
            setMuddatBalance(Number(led.data?.incoming_total || 0));
          } catch { /* ignore */ }
        }
        // Recent activity — combine today's procurement + payments, latest first
        const activity = [
          ...rows.map((r) => ({ kind: "procurement", when: r.created_at,
            title: `${r.product_name} · ${r.weight} qtl · ${formatClientName(r.client_name)}`,
            amount: r.total_amount, tone: "muted" })),
        ];
        setRecentActivity(activity.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 5));
      } catch (e) { /* silent */ }
    })();
  }, []);

  const received = payments.filter((p) => p.direction === "in");
  const given = payments.filter((p) => p.direction === "out");
  const activeLabel = activeDateStr === todayStr ? t("tb.today")
    : activeDateStr === yesterdayStr ? t("tb.yesterday")
    : formatDate(activeDateStr);

  const runCalc = () => {
    const totalIn = received.reduce((s, p) => s + p.amount, 0);
    const totalOut = given.reduce((s, p) => s + p.amount, 0);
    setCalcTotals({ in: totalIn, out: totalOut });
    setShowCalcConfirm(false);
    setShowCalcResult(true);
  };

  const btn = (active) => cn(
    "px-4 py-2 text-sm uppercase tracking-widest border transition-colors",
    active ? "bg-[#292524] text-[#FAFAF9] border-[#292524]" : "border-[#D6D3D1] text-[#292524] hover:bg-[#F0EFEA]"
  );

  return (
    <div className="space-y-6" data-testid="dashboard-page">
      {/* Page eyebrow + title (Edit 7) */}
      <header className="border-b border-[#E7E5E4] pb-4">
        <div className="text-xs uppercase tracking-widest text-stone-500">{t("dashboard.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-serif text-[#1C1917]">{t("dashboard.title")}</h1>
      </header>

      {/* Summary stat cards (Edit 1) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="dashboard-stats">
        <StatCard label={t("dashboard.stat.procuredToday")}
          value={formatCurrency(todayProcurement.cost)}
          subvalue={`${todayProcurement.weight.toLocaleString("en-IN")} qtl · ${todayProcurement.count} ${t("proc.entries")}`}
          tone="positive" emphasis testid="dash-stat-procured" />
        <StatCard label={t("dashboard.stat.paymentsToday")}
          value={formatCurrency(given.reduce((s, p) => s + p.amount, 0))}
          subvalue={`${given.length} ${t("dashboard.entries")}`}
          tone="negative" testid="dash-stat-paid" />
        <StatCard label={t("dashboard.stat.receivedToday")}
          value={formatCurrency(received.reduce((s, p) => s + p.amount, 0))}
          subvalue={`${received.length} ${t("dashboard.entries")}`}
          tone="positive" testid="dash-stat-received" />
        <StatCard label={t("dashboard.stat.muddat")}
          value={formatCurrency(muddatBalance)}
          subvalue="Deductions collected"
          tone="positive" testid="dash-stat-muddat" />
      </div>

      {/* Recent activity */}
      {recentActivity.length > 0 && (
        <section className="bg-white border border-[#E7E5E4]" data-testid="dashboard-recent">
          <div className="px-5 py-3 border-b border-[#E7E5E4] bg-[#F5F4F0]">
            <h2 className="text-sm uppercase tracking-widest text-[#1C1917] font-bold">{t("dashboard.recent.title")}</h2>
          </div>
          <ul className="divide-y divide-[#E7E5E4]">
            {recentActivity.map((a, i) => (
              <li key={i} className="px-5 py-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <Wheat strokeWidth={1.5} className="w-4 h-4 text-stone-400" />
                  <span className="text-[#1C1917]">{a.title}</span>
                </div>
                <span className="font-mono text-[#B45309]">{formatCurrency(a.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Toolbar — left-aligned */}
      <div className="flex flex-wrap items-center gap-2" data-testid="toolbar">
        <button onClick={() => setActiveDate(new Date())} className={btn(activeDateStr === todayStr)} data-testid="today-btn">{t("tb.today")}</button>
        <button onClick={() => setActiveDate(new Date(Date.now() - 86400000))} className={btn(activeDateStr === yesterdayStr)} data-testid="yesterday-btn">{t("tb.yesterday")}</button>
        <div className="w-px h-6 bg-[#D6D3D1] mx-1" />
        <button onClick={() => setShowAdd(true)} data-testid="add-payment-btn"
          className="flex items-center gap-2 bg-[#292524] text-[#FAFAF9] px-4 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
          <Plus strokeWidth={1.5} className="w-4 h-4" /> {t("tb.addPayment").replace("+ ", "")}
        </button>
        <button onClick={() => setShowCalcConfirm(true)} data-testid="calculate-btn"
          className="flex items-center gap-2 border border-[#292524] text-[#292524] px-4 py-2 text-sm uppercase tracking-widest hover:bg-[#292524] hover:text-white">
          <Calculator strokeWidth={1.5} className="w-4 h-4" /> {t("tb.calculateNow")}
        </button>
        <div className="ml-auto text-xs text-stone-500 uppercase tracking-widest">
          {t("tb.active")}: <span className="font-mono text-[#1C1917]" data-testid="active-date-label">{activeLabel} · {formatDate(activeDateStr)}</span>
        </div>
      </div>

      {/* Content: transactions left, calendar right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,auto] gap-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6" data-testid="transactions-grid">
          <section
            onMouseEnter={() => setFocusColumn("in")} onMouseLeave={() => setFocusColumn(null)}
            className={cn("bg-white border border-[#E7E5E4] p-5 transition-all duration-200", focusColumn === "in" && "col-focus-in")}
          >
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#E7E5E4]">
              <div className="flex items-center gap-2 text-emerald-800">
                <ArrowDownLeft strokeWidth={1.5} className="w-4 h-4" />
                <span className="text-sm font-bold uppercase tracking-widest" data-testid="col-received-label">{t("col.received")}</span>
              </div>
              <span className="font-mono text-sm text-emerald-800" data-testid="col-received-total">
                {formatCurrency(received.reduce((s, p) => s + p.amount, 0))}
              </span>
            </div>
            {loading ? (
              <div className="space-y-3 py-2" data-testid="skeleton-in">
                {[1,2,3].map(i => <div key={i} className="skeleton-row" />)}
              </div>
            ) : <PaymentColumn items={received} emptyMsg={t("col.noReceived")} tone="in" testid="col-received" />}
          </section>

          <section
            onMouseEnter={() => setFocusColumn("out")} onMouseLeave={() => setFocusColumn(null)}
            className={cn("bg-white border border-[#E7E5E4] p-5 transition-all duration-200", focusColumn === "out" && "col-focus-out")}
          >
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#E7E5E4]">
              <div className="flex items-center gap-2 text-orange-800">
                <ArrowUpRight strokeWidth={1.5} className="w-4 h-4" />
                <span className="text-sm font-bold uppercase tracking-widest" data-testid="col-given-label">{t("col.given")}</span>
              </div>
              <span className="font-mono text-sm text-orange-800" data-testid="col-given-total">
                {formatCurrency(given.reduce((s, p) => s + p.amount, 0))}
              </span>
            </div>
            {loading ? (
              <div className="space-y-3 py-2" data-testid="skeleton-out">
                {[1,2,3].map(i => <div key={i} className="skeleton-row" />)}
              </div>
            ) : <PaymentColumn items={given} emptyMsg={t("col.noGiven")} tone="out" testid="col-given" />}
          </section>
        </div>

        <aside className="bg-white border border-[#E7E5E4] p-3 self-start" data-testid="calendar-panel">
          <Calendar mode="single" selected={activeDate}
            onSelect={(d) => d && setActiveDate(d)}
            month={calendarMonth} onMonthChange={setCalendarMonth}
            disabled={{ after: today }}
            toDate={today}
            data-testid="historical-calendar" />
        </aside>
      </div>

      <AddPaymentModal open={showAdd} onOpenChange={setShowAdd} onSaved={fetchPayments} defaultDate={activeDateStr} />

      {/* Calculate confirmation */}
      <Dialog open={showCalcConfirm} onOpenChange={setShowCalcConfirm}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="calc-confirm-dialog">
          <DialogHeader>
            <DialogTitle className={`text-xl ${lang === "hi" ? "" : "font-serif"}`}>
              {t("calc.dateConfirm")} <span className="font-mono text-[#1C1917]" data-testid="calc-confirm-date">{formatDate(activeDateStr)}</span>?
            </DialogTitle>
            <DialogDescription className="sr-only">Confirm calculation for the active date</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-4">
            <button onClick={() => setShowCalcConfirm(false)} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-calc-btn">{t("action.cancel")}</button>
            <button onClick={runCalc} data-testid="confirm-calc-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
              {t("action.confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Calculate result — 2 lines exactly */}
      <Dialog open={showCalcResult} onOpenChange={setShowCalcResult}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="calc-result-dialog">
          <DialogHeader>
            <DialogTitle className={`text-xl ${lang === "hi" ? "" : "font-serif"}`}>
              {t("calc.resultTitle")} · <span className="font-mono">{formatDate(activeDateStr)}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">Totals for the selected date</DialogDescription>
          </DialogHeader>
          {calcTotals && (
            <div className="py-4 space-y-4">
              <div className="flex items-center justify-between py-2 border-b border-[#E7E5E4]">
                <span className="text-sm uppercase tracking-widest text-emerald-800">{t("calc.totalReceived")}</span>
                <span className="font-mono text-2xl text-emerald-800" data-testid="calc-total-received">{formatCurrency(calcTotals.in)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm uppercase tracking-widest text-orange-800">{t("calc.totalGiven")}</span>
                <span className="font-mono text-2xl text-orange-800" data-testid="calc-total-given">{formatCurrency(calcTotals.out)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <button onClick={() => setShowCalcResult(false)} data-testid="close-calc-result-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
              {t("add.close")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

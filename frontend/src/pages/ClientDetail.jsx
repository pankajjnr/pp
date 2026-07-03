import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BookOpen, Download, FileText, Calculator, Trash2 } from "lucide-react";
import api, { API_BASE, formatCurrency, formatDate, formatApiError, formatClientName } from "@/lib/api";
import { toast } from "sonner";
import { useLang } from "@/context/LangContext";
import { useAuth } from "@/context/AuthContext";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

function LedgerColumn({ side, entries, total, emptyMsg, t, serif }) {
  const isIn = side === "in";
  const color = isIn ? "text-emerald-800" : "text-orange-800";
  const label = isIn ? t("client.moneyIn") : t("client.moneyOut");
  const sub = isIn ? t("client.collections") : t("client.distributions");
  return (
    <div className={`${isIn ? "pr-0 md:pr-10" : "pl-0 md:pl-10"} py-2`} data-testid={`ledger-${side}`}>
      <div className={`text-xs uppercase tracking-[0.25em] text-stone-500 mb-1 ${isIn ? "md:text-left" : "md:text-right"}`}>{sub}</div>
      <div className={`text-2xl md:text-3xl text-[#1C1917] mb-2 ${serif} ${isIn ? "md:text-left" : "md:text-right"}`}>{label}</div>
      <div className={`font-mono text-xl md:text-2xl mb-6 ${color} ${isIn ? "md:text-left" : "md:text-right"}`}>{formatCurrency(total)}</div>
      <div className="ledger-line">
        {entries.length === 0 ? (
          <div className="text-sm italic text-stone-500 py-6 text-center">{emptyMsg}</div>
        ) : (
          <ul>
            {entries.map((p) => (
              <li key={p.id} className={`flex items-center justify-between h-8 px-1 hover:bg-[#F0EFEA] transition-colors ${isIn ? "" : "flex-row-reverse"}`}>
                <span className="text-xs text-stone-500 font-mono">{formatDate(p.entry_date)}</span>
                <span className={`font-mono ${color}`}>{formatCurrency(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user && user.role === "admin";
  const { t, lang } = useLang();
  const serif = lang === "hi" ? "" : "font-serif";
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCalc, setShowCalc] = useState(false);
  const [calcResult, setCalcResult] = useState(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/clients/${id}/ledger`);
        setLedger(data);
      } catch (e) { toast.error(formatApiError(e)); }
      finally { setLoading(false); }
    })();
  }, [id]);

  const handleExport = async (format) => {
    try {
      const token = localStorage.getItem("ledger_token");
      const res = await fetch(`${API_BASE}/clients/${id}/export?format=${format}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { toast.error("Export failed"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (ledger?.client?.name || "ledger").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
      a.href = url; a.download = `ledger_${safe}.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${format.toUpperCase()} downloaded`);
    } catch (err) { toast.error(String(err)); }
  };

  const runClientCalc = () => {
    setCalcResult({
      total_incoming: ledger.incoming_total,
      total_outgoing: ledger.outgoing_total,
      net: ledger.net_balance,
      count: ledger.incoming.length + ledger.outgoing.length,
    });
    setShowCalc(false);
  };

  if (loading) return <div className={`text-stone-500 py-20 text-center italic text-xl ${serif}`}>{t("client.opening")}</div>;
  if (!ledger) return <div className="text-stone-500 py-20 text-center">{t("client.notFound")}</div>;

  const net = ledger.net_balance;
  const calcNet = calcResult?.net ?? 0;

  return (
    <div className="space-y-8" data-testid="client-detail-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Link to="/clients" data-testid="back-to-clients" className="flex items-center gap-2 text-sm text-stone-600 hover:text-[#1C1917]">
          <ArrowLeft strokeWidth={1.5} className="w-4 h-4" /> {t("client.back")}
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowCalc(true)} data-testid="client-calculate-btn"
            className="flex items-center gap-2 border border-[#292524] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#292524] hover:text-white transition-colors">
            <Calculator strokeWidth={1.5} className="w-4 h-4" /> {t("client.calcButton")}
          </button>
          <button onClick={() => handleExport("csv")} data-testid="export-csv-btn"
            className="flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA]">
            <Download strokeWidth={1.5} className="w-4 h-4" /> CSV
          </button>
          <button onClick={() => handleExport("pdf")} data-testid="export-pdf-btn"
            className="flex items-center gap-2 border border-[#D6D3D1] text-[#292524] px-3 py-2 text-xs uppercase tracking-widest hover:bg-[#F0EFEA]">
            <FileText strokeWidth={1.5} className="w-4 h-4" /> PDF
          </button>
          <Link to="/payments/new" data-testid="add-entry-cta" className="bg-[#292524] text-[#FAFAF9] px-4 py-2 text-xs uppercase tracking-widest hover:bg-[#1C1917]">
            {t("client.newEntry")}
          </Link>
          {isAdmin && (
            <button onClick={() => setShowDelete(true)} data-testid="delete-client-btn"
              className="flex items-center gap-2 border border-red-300 text-red-700 px-3 py-2 text-xs uppercase tracking-widest hover:bg-red-50">
              <Trash2 strokeWidth={1.5} className="w-4 h-4" /> Delete
            </button>
          )}
        </div>
      </div>

      <header className="border-b border-[#D6D3D1] pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-stone-500">
          <BookOpen strokeWidth={1.5} className="w-3.5 h-3.5" /> {t("client.eyebrow")}
        </div>
        <h1 className={`text-4xl sm:text-5xl lg:text-6xl tracking-tight text-[#1C1917] mt-3 font-bold ${serif}`}>{formatClientName(ledger.client.name)}</h1>
        <div className="flex items-baseline gap-6 mt-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-stone-500">{t("totals.netBalance")}</div>
            <div className={`font-mono text-3xl ${net >= 0 ? "text-emerald-800" : "text-orange-800"}`}>
              {net >= 0 ? "+" : "−"}{formatCurrency(Math.abs(net))}
            </div>
          </div>
        </div>
      </header>

      {calcResult && (
        <section className="bg-white border-2 border-[#292524] p-6 sm:p-10 paper-grain" data-testid="client-totals-result">
          <div className="text-xs uppercase tracking-[0.25em] text-stone-500 mb-4">{t("totals.tally")}</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:divide-x-2 md:divide-dashed md:divide-[#D6D3D1]">
            <div className="md:pr-8">
              <div className="text-xs uppercase tracking-widest text-emerald-800">{t("totals.totalIncoming")}</div>
              <div className="font-mono text-3xl text-emerald-800 mt-2" data-testid="client-total-incoming">{formatCurrency(calcResult.total_incoming)}</div>
            </div>
            <div className="md:px-8">
              <div className="text-xs uppercase tracking-widest text-orange-800">{t("totals.totalOutgoing")}</div>
              <div className="font-mono text-3xl text-orange-800 mt-2" data-testid="client-total-outgoing">{formatCurrency(calcResult.total_outgoing)}</div>
            </div>
            <div className="md:pl-8">
              <div className="text-xs uppercase tracking-widest text-stone-500">{t("totals.netBalance")}</div>
              <div className={`font-mono text-3xl mt-2 ${calcNet >= 0 ? "text-emerald-800" : "text-orange-800"}`} data-testid="client-net-balance">
                {calcNet >= 0 ? "+" : "−"}{formatCurrency(Math.abs(calcNet))}
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="bg-white border border-[#E7E5E4] shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] p-6 sm:p-10 relative grid grid-cols-1 md:grid-cols-2 md:divide-x-2 md:divide-dashed md:divide-[#D6D3D1] paper-grain" data-testid="client-ledger-split-view">
        <LedgerColumn side="in" entries={ledger.incoming} total={ledger.incoming_total} emptyMsg={t("client.noIn")} t={t} serif={serif} />
        <LedgerColumn side="out" entries={ledger.outgoing} total={ledger.outgoing_total} emptyMsg={t("client.noOut")} t={t} serif={serif} />
      </div>

      <p className="text-xs text-stone-500 text-center italic">{t("client.permanent")}</p>

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="bg-[#F9F8F6] border border-red-300 rounded-sm" data-testid="delete-client-dialog">
          <DialogHeader>
            <DialogTitle className={`text-2xl text-red-800 ${serif}`}>Delete this client permanently?</DialogTitle>
            <DialogDescription className="text-stone-600">
              This will remove <b>{formatClientName(ledger?.client?.name)}</b> and ALL their payment entries. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-2">
            <button onClick={() => setShowDelete(false)} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-delete-client">Cancel</button>
            <button onClick={async () => {
              setDeleting(true);
              try {
                await api.delete(`/clients/${id}`);
                toast.success("Client deleted");
                navigate("/clients");
              } catch (e) { toast.error(formatApiError(e)); }
              finally { setDeleting(false); setShowDelete(false); }
            }} disabled={deleting} data-testid="confirm-delete-client"
              className="bg-red-700 text-white px-5 py-2 text-sm uppercase tracking-widest hover:bg-red-800 disabled:opacity-60">
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCalc} onOpenChange={setShowCalc}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm" data-testid="client-calc-confirm-dialog">
          <DialogHeader>
            <DialogTitle className={`text-2xl ${serif}`}>{t("client.calcTitle")}</DialogTitle>
            <DialogDescription className="sr-only">Confirm client-level tally</DialogDescription>
          </DialogHeader>
          <p className="text-stone-600 py-2">{t("client.calcText")}</p>
          <DialogFooter className="gap-2">
            <button onClick={() => setShowCalc(false)} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-client-calc-btn">{t("totals.notYet")}</button>
            <button onClick={runClientCalc} data-testid="confirm-client-calc-btn"
              className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917]">
              {t("totals.yesTally")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

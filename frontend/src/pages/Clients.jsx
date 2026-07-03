import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search, UserPlus, ArrowUpRight } from "lucide-react";
import api, { formatCurrency, formatApiError, formatClientName } from "@/lib/api";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";

export default function Clients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/clients");
      setClients(data);
    } catch (e) { toast.error(formatApiError(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setAddError("");
    try {
      await api.post("/clients", { name, note });
      toast.success("Client added to the book");
      setOpen(false); setName(""); setNote("");
      await load();
    } catch (err) {
      const msg = formatApiError(err);
      setAddError(msg);
      toast.error(msg);
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-10" data-testid="clients-page">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-stone-500">The Roster</div>
          <h1 className="font-serif text-4xl sm:text-5xl tracking-tight text-[#1C1917] mt-2">Clients on the books.</h1>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setAddError(""); }}>
          <DialogTrigger asChild>
            <button data-testid="open-add-client-btn" className="bg-[#292524] text-[#FAFAF9] px-5 py-3 uppercase tracking-widest text-xs hover:bg-[#1C1917] transition-colors flex items-center gap-2 self-start md:self-auto">
              <UserPlus strokeWidth={1.5} className="w-4 h-4" /> New client
            </button>
          </DialogTrigger>
          <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm">
            <DialogHeader>
              <DialogTitle className="font-serif text-2xl">Add a new client</DialogTitle>
              <DialogDescription className="sr-only">Create a new client entry</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-5" data-testid="add-client-form">
              <div>
                <label className="text-xs uppercase tracking-widest text-stone-500">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} required data-testid="client-name-input"
                  className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 text-lg focus:outline-none focus:border-[#292524]" />
              </div>
              <div>
                <label className="text-xs uppercase tracking-widest text-stone-500">Note (optional)</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} data-testid="client-note-input"
                  className="mt-2 w-full bg-transparent border-b border-[#D6D3D1] py-2 focus:outline-none focus:border-[#292524]" />
              </div>
              {addError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2" data-testid="add-client-error">
                  {addError}
                </div>
              )}
              <DialogFooter className="gap-2">
                <button type="button" onClick={() => { setOpen(false); setAddError(""); }} className="border border-[#D6D3D1] px-4 py-2 text-sm hover:bg-[#F0EFEA]" data-testid="cancel-add-client">Cancel</button>
                <button type="submit" disabled={saving} data-testid="submit-add-client" className="bg-[#292524] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#1C1917] disabled:opacity-60">{saving ? "Saving…" : "Add client"}</button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-3 border-b border-[#D6D3D1] pb-3">
        <Search strokeWidth={1.5} className="w-4 h-4 text-stone-500" />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a name…" data-testid="client-search-input"
          className="flex-1 bg-transparent focus:outline-none text-lg" />
        <span className="text-xs font-mono text-stone-500">{filtered.length} / {clients.length}</span>
      </div>

      {loading ? (
        <div className="text-sm text-stone-500 py-16 text-center">Reading the book…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[#D6D3D1]">
          <div className="font-serif text-2xl text-stone-500 italic">No clients yet.</div>
          <div className="text-sm text-stone-500 mt-2">Press "New client" to begin.</div>
        </div>
      ) : (
        <div className="border border-[#E7E5E4] bg-white">
          <div className="grid grid-cols-[1fr,auto,auto,auto] px-6 py-3 text-xs uppercase tracking-widest text-stone-500 border-b border-[#E7E5E4] gap-6">
            <div>Name</div>
            <div className="hidden sm:block text-right">Incoming</div>
            <div className="hidden sm:block text-right">Outgoing</div>
            <div className="text-right">Net</div>
          </div>
          <ul>
            {filtered.map((c) => (
              <li key={c.id}>
                <Link to={`/clients/${c.id}`} data-testid={`client-row-${c.id}`}
                  className="grid grid-cols-[1fr,auto,auto,auto] items-center px-6 py-4 gap-6 border-b border-[#E7E5E4] last:border-b-0 hover:bg-[#F9F8F6] transition-colors group">
                  <div>
                    <div className="font-serif text-xl text-[#1C1917]">{formatClientName(c.name)}</div>
                    {c.note && <div className="text-xs text-stone-500 mt-0.5">{c.note}</div>}
                  </div>
                  <div className="hidden sm:block font-mono text-emerald-800 text-right">{formatCurrency(c.incoming_total)}</div>
                  <div className="hidden sm:block font-mono text-orange-800 text-right">{formatCurrency(c.outgoing_total)}</div>
                  <div className="flex items-center gap-3 justify-end">
                    <div className={`font-mono text-lg ${c.net_balance >= 0 ? "text-emerald-800" : "text-orange-800"}`}>
                      {c.net_balance >= 0 ? "+" : "−"}{formatCurrency(Math.abs(c.net_balance))}
                    </div>
                    <ArrowUpRight strokeWidth={1.5} className="w-4 h-4 text-stone-400 group-hover:text-[#292524]" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

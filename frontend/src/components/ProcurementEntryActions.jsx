import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import api, { formatApiError, formatClientName, formatCurrency } from "@/lib/api";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

/**
 * Edit / delete buttons for one saved procurement entry.
 * Settled entries are locked (the server refuses to change them too) —
 * undo the settlement first.
 */
export default function ProcurementEntryActions({ entry, onChanged }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (entry.is_settled) {
    return <span className="text-[10px] uppercase tracking-widest text-stone-400">Settled</span>;
  }

  const total = (() => {
    const w = parseFloat(form?.weight);
    const r = parseFloat(form?.rate);
    return isNaN(w) || isNaN(r) ? 0 : +(w * r).toFixed(2);
  })();

  const openEdit = async () => {
    setForm({
      entry_date: entry.entry_date,
      client_id: entry.client_id,
      product_id: entry.product_id,
      weight: String(entry.weight),
      rate: String(entry.rate),
    });
    setOpen(true);
    try {
      const [c, p] = await Promise.all([api.get("/clients"), api.get("/procurement/products")]);
      setClients(c.data || []);
      setProducts(p.data || []);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const save = async () => {
    if (!(Number(form.weight) > 0)) return toast.error("Weight must be > 0");
    if (!(Number(form.rate) > 0)) return toast.error("Rate must be > 0");
    setSaving(true);
    try {
      await api.put(`/procurement/entries/${entry.id}`, {
        entry_date: form.entry_date,
        client_id: form.client_id,
        product_id: form.product_id,
        weight: Number(form.weight),
        rate: Number(form.rate),
      });
      toast.success("Entry updated");
      setOpen(false);
      onChanged && onChanged();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = window.confirm(
      `Delete this entry?\n\n${entry.product_name} · ${entry.weight} qtl · ${formatClientName(entry.client_name)} · ${formatCurrency(entry.total_amount)}\n\nThis cannot be undone.`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/procurement/entries/${entry.id}`);
      toast.success("Entry deleted");
      onChanged && onChanged();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setDeleting(false);
    }
  };

  const fieldCls = "mt-1 w-full bg-transparent border-b border-[#D6D3D1] py-2 text-sm focus:outline-none focus:border-[#292524]";
  const labelCls = "text-[11px] uppercase tracking-widest text-stone-500";

  return (
    <>
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={openEdit} title="Edit" data-testid={`entry-edit-${entry.id}`}
          className="text-stone-500 hover:text-[#292524]">
          <Pencil strokeWidth={1.5} className="w-4 h-4" />
        </button>
        <button type="button" onClick={remove} disabled={deleting} title="Delete" data-testid={`entry-delete-${entry.id}`}
          className="text-stone-500 hover:text-red-700 disabled:opacity-40">
          <Trash2 strokeWidth={1.5} className="w-4 h-4" />
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">Edit entry</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Date can only be today or yesterday. Settled entries cannot be edited.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" value={form.entry_date}
                  onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                  className={`${fieldCls} font-mono`} />
              </div>
              <div>
                <label className={labelCls}>Client</label>
                <select value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}
                  className={fieldCls}>
                  {clients.length === 0 && <option value={form.client_id}>{formatClientName(entry.client_name)}</option>}
                  {clients.map((c) => <option key={c.id} value={c.id}>{formatClientName(c.name)}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Product</label>
                <select value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}
                  className={fieldCls}>
                  {products.length === 0 && <option value={form.product_id}>{entry.product_name}</option>}
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Weight (Quintal)</label>
                  <input type="number" step="0.01" min="0" value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: e.target.value })}
                    className={`${fieldCls} font-mono`} />
                </div>
                <div>
                  <label className={labelCls}>Rate (₹/Quintal)</label>
                  <input type="number" step="0.01" min="0" value={form.rate}
                    onChange={(e) => setForm({ ...form, rate: e.target.value })}
                    className={`${fieldCls} font-mono`} />
                </div>
              </div>
              <div className="pt-2 border-t border-dashed border-[#E7E5E4]">
                <div className={labelCls}>Total amount</div>
                <div className="font-mono text-2xl text-[#1C1917]">{formatCurrency(total)}</div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 pt-4">
            <button type="button" onClick={() => setOpen(false)}
              className="border border-[#D6D3D1] text-[#292524] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#F0EFEA]">
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving}
              className="bg-[#B45309] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60">
              {saving ? "Saving…" : "Save changes"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

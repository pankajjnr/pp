import { useEffect, useRef, useState } from "react";
import { Download, Upload, Shield, AlertCircle, CheckCircle2, Info } from "lucide-react";
import { toast } from "sonner";
import api, { formatApiError, formatDate } from "@/lib/api";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useAuth } from "@/context/AuthContext";
import usePageTitle from "@/hooks/usePageTitle";
import { cn } from "@/lib/utils";

export default function BackupRestore() {
  usePageTitle("Backup & Restore");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [status, setStatus] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const loadStatus = () => {
    api.get("/admin/backup/status")
      .then((r) => setStatus(r.data))
      .catch(() => {});
  };
  useEffect(() => { if (isAdmin) loadStatus(); }, [isAdmin]);

  const downloadBackup = async () => {
    setDownloading(true);
    try {
      const res = await api.get("/admin/backup/export", { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      a.download = `backup_${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success("Backup downloaded — store this file somewhere safe.");
      loadStatus();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally { setDownloading(false); }
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPendingFile(f);
    setResult(null);
    setConfirmOpen(true);
  };

  const doRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const res = await api.post("/admin/backup/restore", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(res.data);
      toast.success("Restore complete");
      loadStatus();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setRestoring(false);
      setConfirmOpen(false);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center text-stone-500" data-testid="backup-forbidden">
        <Shield className="w-10 h-10 mx-auto mb-3 text-stone-400" strokeWidth={1.5} />
        This page is for admin only.
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="backup-restore-page">
      <header className="border-b border-[#E7E5E4] pb-4">
        <div className="text-xs uppercase tracking-widest text-stone-500">Admin</div>
        <h1 className="mt-1 text-3xl font-serif text-[#1C1917]">Backup &amp; Restore</h1>
        <p className="text-sm text-stone-500 mt-1">
          Full data snapshot as a single zip file — safe to store outside this app.
        </p>
      </header>

      {/* Status */}
      <StatusPanel status={status} />

      {/* Download */}
      <section className="bg-white border border-[#E7E5E4] p-6 space-y-3" data-testid="backup-download-panel">
        <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#1C1917] font-bold">
          <Download strokeWidth={1.5} className="w-4 h-4" /> Download Full Backup
        </div>
        <p className="text-sm text-stone-500">
          Bundles every clients, products, procurement entry, payment and settlement into one zip
          with a manifest. Save this file to Google Drive, an external drive, or a USB stick.
        </p>
        <button onClick={downloadBackup} disabled={downloading} data-testid="download-backup-btn"
          className="inline-flex items-center gap-2 bg-[#B45309] text-[#FAFAF9] px-5 py-2.5 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60">
          <Download strokeWidth={1.5} className="w-4 h-4" />
          {downloading ? "Preparing…" : "Download Full Backup"}
        </button>
      </section>

      {/* Restore */}
      <section className="bg-white border border-[#E7E5E4] p-6 space-y-3" data-testid="backup-restore-panel">
        <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-[#1C1917] font-bold">
          <Upload strokeWidth={1.5} className="w-4 h-4" /> Restore from Backup
        </div>
        <p className="text-sm text-stone-500">
          Upload a zip previously produced by this page. Documents with matching IDs will be
          overwritten; new IDs will be inserted. <strong>Existing data is not deleted.</strong>
        </p>
        <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={onPickFile}
          data-testid="restore-file-input"
          className="block text-sm file:mr-3 file:py-2 file:px-4 file:border file:border-[#D6D3D1] file:bg-[#F5F4F0] file:text-[#292524] file:uppercase file:tracking-widest file:text-xs file:cursor-pointer hover:file:bg-[#F0EFEA]" />
        {result && <RestoreResult result={result} />}
      </section>

      {/* Safety note */}
      <section className="bg-[#FEF3C7] border border-[#B45309] p-4 text-sm text-[#78350F] flex gap-3" data-testid="backup-safety">
        <Info strokeWidth={1.5} className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="space-y-1">
          <p><strong>A backup only restores data as of when it was taken.</strong> Any entry made after the
            last backup and before a crash will not be recoverable.</p>
          <p>Recommend storing the downloaded zip <em>outside this app</em> (your computer, external
            drive, cloud storage) and testing the restore flow at least once before relying on it.</p>
        </div>
      </section>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={(v) => { if (!v) { setConfirmOpen(false); setPendingFile(null); if (fileRef.current) fileRef.current.value = ""; } }}>
        <DialogContent className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-sm max-w-md" data-testid="restore-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif text-[#1C1917]">Restore backup?</DialogTitle>
            <DialogDescription className="text-sm text-stone-600 space-y-2">
              <span className="block">This will add or overwrite documents by their IDs from the uploaded file.</span>
              <span className="block">Existing data not present in the backup will <strong>not</strong> be deleted.</span>
              {pendingFile && (
                <span className="block mt-2 font-mono text-xs text-stone-500">
                  File: {pendingFile.name} ({Math.round(pendingFile.size / 1024)} KB)
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-4">
            <button onClick={() => { setConfirmOpen(false); setPendingFile(null); if (fileRef.current) fileRef.current.value = ""; }}
              disabled={restoring} data-testid="restore-cancel-btn"
              className="border border-[#D6D3D1] text-[#292524] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#F0EFEA] disabled:opacity-60">
              Cancel
            </button>
            <button onClick={doRestore} disabled={restoring} data-testid="restore-confirm-btn"
              className="bg-[#B45309] text-[#FAFAF9] px-5 py-2 text-sm uppercase tracking-widest hover:bg-[#92400E] disabled:opacity-60">
              {restoring ? "Restoring…" : "Yes, Restore"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPanel({ status }) {
  if (!status) return null;
  const overdue = status.is_overdue;
  return (
    <div className={cn(
      "bg-white border p-5 flex items-start gap-3",
      overdue ? "border-[#B45309]" : "border-[#E7E5E4]"
    )} data-testid="backup-status-panel">
      {overdue
        ? <AlertCircle strokeWidth={1.5} className="w-5 h-5 text-[#B45309] mt-0.5" />
        : <CheckCircle2 strokeWidth={1.5} className="w-5 h-5 text-emerald-700 mt-0.5" />}
      <div className="flex-1">
        <div className="text-[11px] uppercase tracking-widest text-stone-500">Last Backup</div>
        <div className="mt-1 text-lg font-serif text-[#1C1917]" data-testid="last-backup-line">
          {status.last_backup_at
            ? <>{formatDate(status.last_backup_at)} · <span className="text-sm text-stone-500">
                {status.days_since_last_backup === 0 ? "today" : `${status.days_since_last_backup} days ago`}
              </span></>
            : "No backup taken yet."}
        </div>
        {overdue && (
          <div className="text-xs text-[#B45309] mt-1">
            Overdue — threshold is {status.reminder_threshold_days} days.
          </div>
        )}
      </div>
    </div>
  );
}

function RestoreResult({ result }) {
  return (
    <div className="mt-4 border border-[#E7E5E4]" data-testid="restore-result">
      <div className="px-4 py-2 bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500 flex items-center justify-between">
        <span>Restore Summary</span>
        <span className="font-mono text-stone-500">
          {result.manifest?.generated_at ? new Date(result.manifest.generated_at).toLocaleString("en-IN") : ""}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-[#F5F4F0] text-[11px] uppercase tracking-widest text-stone-500">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Collection</th>
            <th className="text-right px-4 py-2 font-medium">Expected</th>
            <th className="text-right px-4 py-2 font-medium">Inserted</th>
            <th className="text-right px-4 py-2 font-medium">Updated</th>
            <th className="text-right px-4 py-2 font-medium">Failed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E7E5E4]">
          {Object.entries(result.summary || {}).map(([name, s]) => (
            <tr key={name} data-testid={`restore-row-${name}`}>
              <td className="px-4 py-2">{name}</td>
              <td className="px-4 py-2 text-right font-mono">{s.expected ?? "—"}</td>
              <td className="px-4 py-2 text-right font-mono text-[#B45309]">{s.inserted}</td>
              <td className="px-4 py-2 text-right font-mono">{s.updated}</td>
              <td className={cn("px-4 py-2 text-right font-mono", s.failed > 0 && "text-[#9F1D1D]")}>{s.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

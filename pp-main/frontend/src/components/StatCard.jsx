import { cn } from "@/lib/utils";

/**
 * Bordered stat card. Uppercase tracked label + large value below.
 * Matches the existing "hairline border, white bg" pattern used across the app.
 */
export default function StatCard({ label, value, subvalue, testid, tone, emphasis }) {
  const valueColor =
    tone === "positive" ? "text-[#B45309]" :
    tone === "negative" ? "text-[#9F1D1D]" :
    tone === "muted"    ? "text-stone-500" :
    "text-[#1C1917]";
  return (
    <div className="bg-white border border-[#E7E5E4] p-5" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={cn(
        "mt-2 font-mono",
        emphasis ? "text-3xl font-semibold" : "text-2xl",
        valueColor,
      )}>
        {value}
      </div>
      {subvalue && (
        <div className="mt-1 text-[11px] text-stone-500 font-mono">{subvalue}</div>
      )}
    </div>
  );
}

import { Inbox } from "lucide-react";

/**
 * Reusable empty state — small icon, one line of text, optional action button.
 * Use anywhere a list/table can be empty.
 */
export default function EmptyState({ icon: Icon = Inbox, label, action, testid }) {
  return (
    <div className="py-10 px-4 flex flex-col items-center gap-3 text-stone-500" data-testid={testid}>
      <div className="w-10 h-10 rounded-full bg-[#F5F4F0] border border-[#E7E5E4] flex items-center justify-center">
        <Icon strokeWidth={1.5} className="w-5 h-5" />
      </div>
      <div className="text-sm">{label}</div>
      {action && (
        <button
          onClick={action.onClick}
          data-testid={action.testid || `${testid}-action`}
          className="mt-1 text-xs uppercase tracking-widest text-[#B45309] hover:text-[#92400E] underline underline-offset-4">
          {action.label} →
        </button>
      )}
    </div>
  );
}

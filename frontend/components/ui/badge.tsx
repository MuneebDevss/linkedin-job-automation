import {cn} from '@/lib/utils';

const tones: Record<string, string> = {
  completed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  draft_created: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300',
  processing: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  pending: 'border-slate-500/30 bg-slate-500/10 text-slate-300', queued: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-300', completed_with_errors: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  needs_manual_action: 'border-orange-400/30 bg-orange-400/10 text-orange-300',
  submission_unknown: 'border-violet-400/30 bg-violet-400/10 text-violet-300'
};

export function StatusBadge({status, className}: {status: string; className?: string}) {
  return <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', tones[status] || tones.pending, className)}>
    {status.replaceAll('_', ' ')}
  </span>;
}

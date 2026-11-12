import {AlertTriangle, Inbox, LoaderCircle} from 'lucide-react';

export function LoadingState({label = 'Loading data…'}: {label?: string}) { return <div className="flex min-h-48 items-center justify-center gap-3 text-slate-400"><LoaderCircle className="size-5 animate-spin" />{label}</div>; }
export function EmptyState({title, description}: {title: string; description: string}) { return <div className="flex min-h-48 flex-col items-center justify-center text-center"><Inbox className="mb-3 size-8 text-slate-600" /><p className="font-medium text-slate-200">{title}</p><p className="mt-1 max-w-md text-sm text-slate-500">{description}</p></div>; }
export function ErrorState({error}: {error: unknown}) { return <div className="flex min-h-48 items-center justify-center gap-3 text-rose-300"><AlertTriangle className="size-5" />{error instanceof Error ? error.message : 'Something went wrong.'}</div>; }

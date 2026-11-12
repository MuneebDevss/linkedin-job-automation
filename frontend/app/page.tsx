'use client';

import Link from 'next/link';
import {useQuery} from '@tanstack/react-query';
import {AlertTriangle, CheckCircle2, CircleHelp, FileClock, MailCheck, Send, Workflow} from 'lucide-react';
import {queries} from '@/lib/api';
import {formatDate} from '@/lib/utils';
import {PageHeading} from '@/components/page-heading';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {StatusBadge} from '@/components/ui/badge';
import {ErrorState, LoadingState} from '@/components/ui/states';

const metrics = [
  ['applications', 'Total applications', Workflow, 'text-cyan-300'],
  ['submitted', 'Submitted forms', CheckCircle2, 'text-emerald-300'],
  ['gmailDrafts', 'Gmail drafts', MailCheck, 'text-blue-300'],
  ['processing', 'Processing', FileClock, 'text-amber-300'],
  ['failed', 'Failed', AlertTriangle, 'text-rose-300'],
  ['needsManualAction', 'Manual action', CircleHelp, 'text-orange-300'],
  ['submissionUnknown', 'Unknown outcome', CircleHelp, 'text-violet-300']
] as const;

export default function DashboardPage() {
  const {data, isLoading, error} = useQuery({queryKey: ['dashboard'], queryFn: queries.dashboard, refetchInterval: 3000});
  if (isLoading) return <LoadingState label="Loading SQLite dashboard…" />;
  if (error || !data) return <ErrorState error={error} />;
  return <>
    <PageHeading eyebrow="Operations" title="Application command center" description="A live view of applications, Gmail drafts, verified submissions, failures, and durable batch execution." action={<Button onClick={() => location.assign('/submit')}><Send className="size-4" />Submit jobs</Button>} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([key, label, Icon, color]) => <Card key={key}><CardContent className="flex items-center justify-between pt-5"><div><p className="text-xs uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold text-white">{data.totals[key]}</p></div><Icon className={`size-6 ${color}`} /></CardContent></Card>)}
      <Card><CardContent className="pt-5"><p className="text-xs uppercase tracking-wider text-slate-500">Active batches</p><p className="mt-2 text-3xl font-semibold text-white">{data.batches.active}</p></CardContent></Card>
    </section>
    <section className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_.75fr]">
      <Card><CardHeader><CardTitle>Recent applications</CardTitle></CardHeader><CardContent className="space-y-1">
        {data.recentApplications.map(app => <Link key={app.id} href={`/applications/${encodeURIComponent(app.id)}`} className="flex items-center justify-between gap-4 rounded-xl px-3 py-3 hover:bg-slate-800/60"><div className="min-w-0"><p className="truncate font-medium text-white">{app.role || 'Untitled opportunity'}</p><p className="truncate text-xs text-slate-500">{app.company || 'Unknown company'} · {formatDate(app.updatedAt)}</p></div><div className="flex gap-2">{app.workflows.map(workflow => <StatusBadge key={workflow.id} status={workflow.status} />)}</div></Link>)}
        {!data.recentApplications.length && <p className="py-12 text-center text-sm text-slate-500">No applications yet.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent processing activity</CardTitle></CardHeader><CardContent className="space-y-4">
        {data.recentActivity.map(event => <div key={event.id} className="relative border-l border-slate-700 pl-4"><span className="absolute -left-1 top-1 size-2 rounded-full bg-cyan-400" /><div className="flex items-center justify-between gap-2"><StatusBadge status={event.stage} /><time className="text-[11px] text-slate-600">{formatDate(event.createdAt)}</time></div><p className="mt-2 text-sm text-slate-400">{event.message || event.status}</p></div>)}
        {!data.recentActivity.length && <p className="py-12 text-center text-sm text-slate-500">No processing events yet.</p>}
      </CardContent></Card>
    </section>
  </>;
}

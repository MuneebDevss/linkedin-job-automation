'use client';
import Link from 'next/link';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {RotateCcw, ShieldAlert} from 'lucide-react';
import {mutations, queries} from '@/lib/api';
import {formatDate} from '@/lib/utils';
import {PageHeading} from '@/components/page-heading';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {StatusBadge} from '@/components/ui/badge';
import {EmptyState, ErrorState, LoadingState} from '@/components/ui/states';
import {useToast} from '@/components/providers';

export default function RetriesPage() {
  const toast = useToast(); const client = useQueryClient();
  const {data, isLoading, error} = useQuery({queryKey: ['failures'], queryFn: queries.failures, refetchInterval: 5000});
  const retry = useMutation({mutationFn: mutations.retryWorkflow, onSuccess: batch => {toast(`Safe retry queued in ${batch.id}.`); client.invalidateQueries({queryKey: ['failures']});}, onError: error => toast(error instanceof Error ? error.message : 'Retry rejected.')});
  return <><PageHeading eyebrow="Recovery" title="Retry center" description="Eligibility is decided by NestJS from persisted attempts. Successful or uncertain submissions are never retried." />
    {isLoading ? <LoadingState /> : error ? <ErrorState error={error} /> : !data?.length ? <Card><EmptyState title="No failed workflows" description="There are no failures or manual-action records to review." /></Card> : <div className="grid gap-4 xl:grid-cols-2">{data.map(item => <Card key={item.workflow.id}><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>{item.application.role || 'Untitled opportunity'}</CardTitle><CardDescription>{item.application.company || 'Unknown company'} · {item.workflow.type} workflow</CardDescription></div><StatusBadge status={item.workflow.status} /></div></CardHeader><CardContent><div className="rounded-xl bg-slate-950/60 p-4"><p className="flex items-center gap-2 text-sm font-medium text-white"><ShieldAlert className="size-4 text-orange-300" />{item.retryEligible ? 'Eligible for safe retry' : 'Retry blocked'}</p><p className="mt-2 text-sm leading-6 text-slate-400">{item.reason}</p></div><div className="mt-4 flex items-center justify-between"><div className="text-xs text-slate-500"><p>{item.workflow.attempts} attempt(s)</p><p>{formatDate(item.workflow.updatedAt)}</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => location.assign(`/applications/${encodeURIComponent(item.application.id)}`)}>Inspect</Button><Button size="sm" disabled={!item.retryEligible || retry.isPending} onClick={() => retry.mutate(item.workflow.id)}><RotateCcw className="size-4" />Retry</Button></div></div></CardContent></Card>)}</div>}
  </>;
}

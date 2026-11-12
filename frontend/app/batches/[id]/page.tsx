'use client';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowLeft, RotateCcw} from 'lucide-react';
import {mutations, queries} from '@/lib/api';
import {formatDate} from '@/lib/utils';
import {PageHeading} from '@/components/page-heading';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {StatusBadge} from '@/components/ui/badge';
import {Table, Td, Th} from '@/components/ui/table';
import {ErrorState, LoadingState} from '@/components/ui/states';
import {JsonView} from '@/components/ui/json-view';
import {useToast} from '@/components/providers';

export default function BatchDetailPage() {
  const id = decodeURIComponent(String(useParams<{id: string}>().id));
  const toast = useToast(); const client = useQueryClient();
  const {data: batch, isLoading, error} = useQuery({queryKey: ['batch', id], queryFn: () => queries.batch(id), refetchInterval: query => ['queued','processing'].includes(query.state.data?.status || '') ? 2000 : false});
  const retry = useMutation({mutationFn: () => mutations.retryBatch(id), onSuccess: value => {toast(`Retry batch ${value.id} queued.`); client.invalidateQueries({queryKey: ['batch', id]}); location.assign(`/batches/${encodeURIComponent(value.id)}`);}, onError: error => toast(error instanceof Error ? error.message : 'Retry failed.')});
  if (isLoading) return <LoadingState label="Loading batch…" />;
  if (error || !batch) return <ErrorState error={error} />;
  return <><Link href="/batches" className="mb-4 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-white"><ArrowLeft className="size-4" />Batch history</Link>
    <PageHeading eyebrow="Durable batch" title={batch.id} description={`Created ${formatDate(batch.createdAt)} · concurrency ${batch.concurrency}`} action={<div className="flex gap-2"><StatusBadge status={batch.status} /><Button variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw className="size-4" />Retry eligible failures</Button></div>} />
    <section className="grid gap-3 sm:grid-cols-5">{[['Total',batch.total],['Queued',batch.queued],['Processing',batch.processing],['Completed',batch.completed],['Failed',batch.failed]].map(([label,value]) => <Card key={String(label)}><CardContent className="pt-5"><p className="text-xs uppercase text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-white">{value}</p></CardContent></Card>)}</section>
    <Card className="mt-6"><CardHeader><CardTitle>Batch items</CardTitle><CardDescription>Individual outcomes are isolated; one failure never stops the others.</CardDescription></CardHeader><CardContent><Table><thead><tr><Th>#</Th><Th>Input</Th><Th>Status</Th><Th>Application</Th><Th>Attempts</Th><Th>Error</Th></tr></thead><tbody>{batch.items.map(item => <tr key={item.id}><Td>{item.position + 1}</Td><Td className="max-w-md"><p className="line-clamp-2 text-white">{String(item.input.text || item.input.url || 'Job entry')}</p><JsonView value={item.input} label="input" /></Td><Td><StatusBadge status={item.status} /></Td><Td>{item.applicationId ? <Link className="font-mono text-xs text-cyan-300" href={`/applications/${encodeURIComponent(item.applicationId)}`}>{item.applicationId}</Link> : '—'}</Td><Td>{item.attempts}</Td><Td className="max-w-xs text-rose-300">{item.error || '—'}</Td></tr>)}</tbody></Table></CardContent></Card>
  </>;
}

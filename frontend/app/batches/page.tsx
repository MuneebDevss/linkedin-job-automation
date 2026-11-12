'use client';
import Link from 'next/link';
import {useQuery} from '@tanstack/react-query';
import {queries} from '@/lib/api';
import {formatDate} from '@/lib/utils';
import {PageHeading} from '@/components/page-heading';
import {Card} from '@/components/ui/card';
import {StatusBadge} from '@/components/ui/badge';
import {Table, Td, Th} from '@/components/ui/table';
import {EmptyState, ErrorState, LoadingState} from '@/components/ui/states';

export default function BatchesPage() {
  const {data, isLoading, error} = useQuery({queryKey: ['batches'], queryFn: () => queries.batches(), refetchInterval: 3000});
  return <><PageHeading eyebrow="Queue" title="Batch history" description="Every bulk request is persisted in SQLite before execution and can be reopened after a restart." />
    <Card>{isLoading ? <LoadingState /> : error ? <ErrorState error={error} /> : !data?.items.length ? <EmptyState title="No batches" description="Submit several jobs to create the first durable batch." /> : <Table><thead><tr><Th>Batch</Th><Th>Status</Th><Th>Progress</Th><Th>Concurrency</Th><Th>Created</Th></tr></thead><tbody>{data.items.map(batch => <tr key={batch.id} className="hover:bg-slate-800/30"><Td><Link href={`/batches/${encodeURIComponent(batch.id)}`} className="font-mono text-xs text-cyan-300">{batch.id}</Link></Td><Td><StatusBadge status={batch.status} /></Td><Td><span className="text-emerald-300">{batch.completed} complete</span> · <span className="text-rose-300">{batch.failed} failed</span> · {batch.queued} queued · {batch.processing} active</Td><Td>{batch.concurrency}</Td><Td>{formatDate(batch.createdAt)}</Td></tr>)}</tbody></Table>}</Card>
  </>;
}

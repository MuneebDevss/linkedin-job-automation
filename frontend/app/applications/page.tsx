'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {useQuery} from '@tanstack/react-query';
import {ArrowDownUp, Search} from 'lucide-react';
import {queries} from '@/lib/api';
import {formatDate} from '@/lib/utils';
import {PageHeading} from '@/components/page-heading';
import {Card, CardContent} from '@/components/ui/card';
import {Input, Select} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {StatusBadge} from '@/components/ui/badge';
import {Table, Td, Th} from '@/components/ui/table';
import {EmptyState, ErrorState, LoadingState} from '@/components/ui/states';

export default function ApplicationsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [sort, setSort] = useState('updatedAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const params = useMemo(() => new URLSearchParams({page: String(page), pageSize: '20', ...(search ? {search} : {}), ...(status ? {status} : {}), ...(method ? {method} : {}), sort, direction}), [page, search, status, method, sort, direction]);
  const {data, isLoading, error} = useQuery({queryKey: ['applications', params.toString()], queryFn: () => queries.applications(params), placeholderData: previous => previous});
  return <>
    <PageHeading eyebrow="Records" title="Applications" description="Search and inspect the SQLite system of record. Gmail draft completion is displayed separately from verified form submission." />
    <Card><CardContent className="grid gap-3 pt-5 md:grid-cols-[minmax(240px,1fr)_repeat(3,auto)_auto]">
      <label className="relative"><Search className="absolute left-3 top-3 size-4 text-slate-500" /><Input className="pl-9" value={search} onChange={event => {setSearch(event.target.value); setPage(1);}} placeholder="Company, role, location, description…" /></label>
      <Select value={status} onChange={event => {setStatus(event.target.value); setPage(1);}}><option value="">All statuses</option>{['pending','processing','completed','failed','needs_manual_action','submission_unknown'].map(value => <option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</Select>
      <Select value={method} onChange={event => {setMethod(event.target.value); setPage(1);}}><option value="">All methods</option>{['email','form','email_and_form','needs_review'].map(value => <option key={value}>{value}</option>)}</Select>
      <Select value={sort} onChange={event => setSort(event.target.value)}><option value="updatedAt">Recently updated</option><option value="createdAt">Date created</option><option value="company">Company</option><option value="role">Role</option><option value="status">Status</option></Select>
      <Button variant="outline" size="icon" aria-label="Toggle sort direction" onClick={() => setDirection(value => value === 'asc' ? 'desc' : 'asc')}><ArrowDownUp className="size-4" /></Button>
    </CardContent></Card>
    <Card className="mt-4">
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} /> : !data?.items.length ? <EmptyState title="No applications found" description="Adjust the filters or submit your first batch." /> : <Table><thead><tr><Th>Opportunity</Th><Th>Method</Th><Th>Resume</Th><Th>Email workflow</Th><Th>Form workflow</Th><Th>Attempts</Th><Th>Latest error</Th><Th>Updated</Th></tr></thead><tbody>{data.items.map(app => {
        const email = app.workflows.find(workflow => workflow.type === 'email'); const form = app.workflows.find(workflow => workflow.type === 'form');
        const latestError = app.workflows.map(workflow => workflow.error).find(Boolean);
        return <tr key={app.id} className="hover:bg-slate-800/30"><Td><Link href={`/applications/${encodeURIComponent(app.id)}`} className="font-medium text-white hover:text-cyan-300">{app.role || 'Untitled opportunity'}</Link><p className="mt-1 max-w-sm truncate text-xs text-slate-500">{app.company || 'Unknown company'}{app.location ? ` · ${app.location}` : ''}</p></Td><Td>{app.applicationChannel || app.method}</Td><Td>{app.selectedResume || '—'}</Td><Td>{email ? <StatusBadge status={email.outcome === 'draft_created' ? 'draft_created' : email.status} /> : '—'}</Td><Td>{form ? <StatusBadge status={form.status} /> : '—'}</Td><Td>{app.workflows.reduce((sum, workflow) => sum + workflow.attempts, 0)}</Td><Td className="max-w-xs truncate text-xs text-rose-300" title={latestError || undefined}>{latestError || '—'}</Td><Td className="whitespace-nowrap text-xs">{formatDate(app.updatedAt)}</Td></tr>;
      })}</tbody></Table>}
    </Card>
    {data && <div className="mt-4 flex items-center justify-between text-sm text-slate-500"><span>{data.total} applications · page {data.page} of {data.pages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= data.pages} onClick={() => setPage(value => value + 1)}>Next</Button></div></div>}
  </>;
}

'use client';

import {useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Plus, Send, Trash2, WandSparkles} from 'lucide-react';
import {mutations} from '@/lib/api';
import type {JobInput} from '@/lib/types';
import {PageHeading} from '@/components/page-heading';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Input, Select} from '@/components/ui/input';
import {useToast} from '@/components/providers';
import {StatusBadge} from '@/components/ui/badge';

type Draft = {id: string; text: string; url: string; links: string};
const blank = (): Draft => ({id: crypto.randomUUID(), text: '', url: '', links: ''});

export default function SubmitPage() {
  const toast = useToast();
  const [bulk, setBulk] = useState('');
  const [entries, setEntries] = useState<Draft[]>([blank()]);
  const [concurrency, setConcurrency] = useState(3);
  const mutation = useMutation({mutationFn: ({jobs, concurrency}: {jobs: JobInput[]; concurrency: number}) => mutations.createBatch(jobs, concurrency), onSuccess: batch => {toast(`Batch ${batch.id} queued with ${batch.total} job(s).`); location.assign(`/batches/${encodeURIComponent(batch.id)}`);}, onError: error => toast(error instanceof Error ? error.message : 'Batch submission failed.')});

  const parse = () => {
    const chunks = bulk.split(/\n\s*(?:---+|===+|###\s*JOB\s*###)\s*\n/gi).map(value => value.trim()).filter(Boolean);
    const parsed = chunks.map(chunk => {
      const urls = chunk.match(/https?:\/\/[^\s<>"']+/g) || [];
      const linkedin = urls.find(url => /linkedin\.com/i.test(url)) || '';
      const links = urls.filter(url => url !== linkedin);
      return {id: crypto.randomUUID(), text: chunk, url: linkedin, links: links.join('\n')};
    });
    if (parsed.length) { setEntries(parsed); toast(`Parsed ${parsed.length} editable job entries.`); }
  };
  const update = (id: string, key: keyof Omit<Draft, 'id'>, value: string) => setEntries(items => items.map(item => item.id === id ? {...item, [key]: value} : item));
  const submit = () => {
    const now = new Date().toISOString();
    const jobs = entries.filter(entry => entry.text.trim() || entry.url.trim()).map(entry => ({
      text: entry.text.trim() || entry.url.trim(), url: entry.url.trim() || undefined,
      links: entry.links.split(/\n|,/).map(link => link.trim()).filter(Boolean), capturedAt: now
    }));
    if (!jobs.length) return toast('Add at least one job description or URL.');
    mutation.mutate({jobs, concurrency});
  };

  return <>
    <PageHeading eyebrow="Intake" title="Bulk job submission" description="Paste multiple posts with a separator, review every entry, then persist the entire batch before backend processing begins." />
    <Card><CardHeader><CardTitle>Paste multiple posts</CardTitle><CardDescription>Separate entries with a line containing <code>---</code>, <code>===</code>, or <code>### JOB ###</code>.</CardDescription></CardHeader><CardContent>
      <textarea value={bulk} onChange={event => setBulk(event.target.value)} placeholder={'Post one…\n---\nPost two…'} className="min-h-40 w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" />
      <Button variant="outline" className="mt-3" onClick={parse} disabled={!bulk.trim()}><WandSparkles className="size-4" />Parse entries</Button>
    </CardContent></Card>
    <div className="mt-6 flex items-center justify-between"><div><h2 className="font-semibold text-white">Review entries</h2><p className="text-sm text-slate-500">{entries.length} job{entries.length === 1 ? '' : 's'} ready for editing</p></div><Button variant="outline" onClick={() => setEntries(items => [...items, blank()])}><Plus className="size-4" />Add entry</Button></div>
    <div className="mt-3 space-y-4">{entries.map((entry, index) => <Card key={entry.id}><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Entry {index + 1}</CardTitle><CardDescription>One failure will not stop other entries.</CardDescription></div><Button variant="ghost" size="icon" aria-label={`Remove entry ${index + 1}`} disabled={entries.length === 1} onClick={() => setEntries(items => items.filter(item => item.id !== entry.id))}><Trash2 className="size-4" /></Button></CardHeader><CardContent className="grid gap-3">
      <textarea value={entry.text} onChange={event => update(entry.id, 'text', event.target.value)} placeholder="Job description or LinkedIn post text" className="min-h-32 w-full rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm text-white focus:border-cyan-500 focus:outline-none" />
      <div className="grid gap-3 lg:grid-cols-2"><Input value={entry.url} onChange={event => update(entry.id, 'url', event.target.value)} placeholder="LinkedIn source URL" /><Input value={entry.links} onChange={event => update(entry.id, 'links', event.target.value)} placeholder="Application URL(s), comma or newline separated" /></div>
    </CardContent></Card>)}</div>
    <div className="sticky bottom-4 mt-6 flex flex-col gap-3 rounded-2xl border border-cyan-500/20 bg-slate-950/90 p-4 shadow-2xl backdrop-blur sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><label className="text-sm text-slate-400" htmlFor="concurrency">Concurrency</label><Select id="concurrency" value={concurrency} onChange={event => setConcurrency(Number(event.target.value))}>{[1,2,3,4,5,6,7,8,9,10].map(value => <option key={value}>{value}</option>)}</Select><StatusBadge status="queued" /></div><Button onClick={submit} disabled={mutation.isPending}><Send className="size-4" />{mutation.isPending ? 'Persisting batch…' : `Submit ${entries.length} jobs`}</Button></div>
  </>;
}

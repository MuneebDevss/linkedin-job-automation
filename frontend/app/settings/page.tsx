'use client';
import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Database, Download, KeyRound, Radio} from 'lucide-react';
import {connectionSettings, mutations, queries, saveConnectionSettings} from '@/lib/api';
import {PageHeading} from '@/components/page-heading';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {StatusBadge} from '@/components/ui/badge';
import {useToast} from '@/components/providers';

export default function SettingsPage() {
  const toast = useToast(); const client = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3000/api/jobs'); const [token, setToken] = useState('');
  useEffect(() => {const current = connectionSettings(); setBaseUrl(current.url); setToken(current.token);}, []);
  const health = useQuery({queryKey: ['health'], queryFn: queries.health, retry: false, refetchInterval: 5000});
  const importer = useMutation({mutationFn: mutations.importSheets, onSuccess: result => toast(`Import complete: ${result.imported} imported, ${result.duplicates} duplicates.`), onError: error => toast(error instanceof Error ? error.message : 'Import failed.')});
  const save = () => {saveConnectionSettings(baseUrl, token); client.clear(); toast('Backend connection saved for this browser session.'); setTimeout(() => location.reload(), 250);};
  return <><PageHeading eyebrow="Local configuration" title="Settings and connection" description="Credentials stay in session storage and are sent only to the configured local NestJS API." />
    <div className="grid gap-6 xl:grid-cols-2"><Card><CardHeader><CardTitle>Backend connection</CardTitle><CardDescription>The frontend never opens SQLite directly.</CardDescription></CardHeader><CardContent className="space-y-4"><label className="block"><span className="mb-2 flex items-center gap-2 text-sm text-slate-400"><Radio className="size-4" />NestJS API URL</span><Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label><label className="block"><span className="mb-2 flex items-center gap-2 text-sm text-slate-400"><KeyRound className="size-4" />API key</span><Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Optional for loopback-only use" /></label><Button onClick={save}>Save and reconnect</Button></CardContent></Card>
      <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Backend status</CardTitle><CardDescription>Polled every five seconds</CardDescription></div><StatusBadge status={health.data?.status === 'ok' ? 'completed' : health.isError ? 'failed' : 'processing'} /></div></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{[[Database,'Database',health.data?.database || 'unreachable'],[Radio,'Queue',health.data?.queue || 'unreachable']].map(([Icon,label,value]) => {const Component = Icon as typeof Database; return <div key={String(label)} className="rounded-xl border border-slate-800 p-4"><Component className="size-5 text-cyan-300" /><p className="mt-3 text-xs uppercase text-slate-600">{String(label)}</p><p className="mt-1 font-medium text-white">{String(value)}</p></div>;})}</CardContent></Card>
      <Card className="xl:col-span-2"><CardHeader><CardTitle>One-time legacy import</CardTitle><CardDescription>Reads historical Google Sheets rows into SQLite. It never executes Gmail or form workflows and never writes back to Sheets.</CardDescription></CardHeader><CardContent className="flex flex-col items-start gap-3"><Button variant="outline" onClick={() => importer.mutate()} disabled={importer.isPending}><Download className="size-4" />{importer.isPending ? 'Importing…' : 'Import legacy Google Sheet'}</Button><p className="text-xs text-slate-500">Configure read-only credentials in the backend, run once, then remove them.</p></CardContent></Card>
    </div>
  </>;
}

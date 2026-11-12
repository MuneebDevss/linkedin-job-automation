'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Activity, BriefcaseBusiness, History, LayoutDashboard, RotateCcw, Send, Settings, Workflow} from 'lucide-react';
import {cn} from '@/lib/utils';

const navigation = [
  {href: '/', label: 'Overview', icon: LayoutDashboard},
  {href: '/submit', label: 'Bulk submission', icon: Send},
  {href: '/applications', label: 'Applications', icon: BriefcaseBusiness},
  {href: '/batches', label: 'Batch history', icon: History},
  {href: '/retries', label: 'Retry center', icon: RotateCcw},
  {href: '/settings', label: 'Settings', icon: Settings}
];

export function AppShell({children}: {children: React.ReactNode}) {
  const pathname = usePathname();
  return <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
    <aside className="border-b border-slate-800 bg-slate-950/90 px-4 py-4 backdrop-blur lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:p-5">
      <Link href="/" className="mb-5 flex items-center gap-3 px-2 lg:mb-8">
        <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 text-slate-950"><Workflow className="size-5" /></span>
        <span><strong className="block text-sm text-white">Job Control</strong><span className="text-xs text-slate-500">SQLite automation</span></span>
      </Link>
      <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Primary navigation">
        {navigation.map(item => { const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href); return <Link key={item.href} href={item.href} className={cn('flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors', active ? 'bg-cyan-400/10 text-cyan-300' : 'text-slate-400 hover:bg-slate-900 hover:text-white')}><item.icon className="size-4" />{item.label}</Link>; })}
      </nav>
      <div className="mt-8 hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 lg:block"><div className="flex items-center gap-2 text-xs font-medium text-emerald-300"><Activity className="size-3.5" />SQLite is authoritative</div><p className="mt-2 text-xs leading-5 text-slate-500">Frontend refreshes never interrupt backend processing.</p></div>
    </aside>
    <main className="min-w-0 p-4 sm:p-6 lg:p-8">{children}</main>
  </div>;
}

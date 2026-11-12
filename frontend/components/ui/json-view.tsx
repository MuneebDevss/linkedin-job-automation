'use client';
import {useState} from 'react';
import {Button} from './button';

export function JsonView({value, label = 'Raw JSON'}: {value: unknown; label?: string}) {
  const [open, setOpen] = useState(false);
  return <div><Button variant="ghost" size="sm" onClick={() => setOpen(value => !value)}>{open ? 'Hide' : 'Show'} {label}</Button>
    {open && <pre className="mt-2 max-h-[34rem] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300">{JSON.stringify(value, null, 2)}</pre>}
  </div>;
}

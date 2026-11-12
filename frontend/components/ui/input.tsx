import * as React from 'react';
import {cn} from '@/lib/utils';
export function Input({className, ...props}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('h-10 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500', className)} {...props} />;
}
export function Textarea({className, ...props}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('min-h-28 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500', className)} {...props} />;
}
export function Select({className, ...props}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('h-10 rounded-lg border border-slate-700 bg-slate-950/70 px-3 text-sm text-white focus:border-cyan-500 focus:outline-none', className)} {...props} />;
}

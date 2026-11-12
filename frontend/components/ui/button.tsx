import * as React from 'react';
import {cn} from '@/lib/utils';

export function Button({className, variant = 'default', size = 'default', ...props}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'default' | 'sm' | 'icon'
}) {
  return <button className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:pointer-events-none disabled:opacity-50',
    variant === 'default' && 'bg-cyan-500 text-slate-950 hover:bg-cyan-400',
    variant === 'outline' && 'border border-slate-700 bg-slate-900/70 text-slate-100 hover:bg-slate-800',
    variant === 'ghost' && 'text-slate-300 hover:bg-slate-800 hover:text-white',
    variant === 'danger' && 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25',
    size === 'default' && 'h-10 px-4', size === 'sm' && 'h-8 px-3 text-sm', size === 'icon' && 'size-9', className)} {...props} />;
}

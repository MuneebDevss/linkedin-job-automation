import * as React from 'react';
import {cn} from '@/lib/utils';

export function Card({className, ...props}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-2xl border border-slate-800 bg-slate-900/70 shadow-[0_16px_50px_-30px_rgba(34,211,238,.35)]', className)} {...props} />;
}
export function CardHeader({className, ...props}: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn('p-5 pb-2', className)} {...props} />; }
export function CardTitle({className, ...props}: React.HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn('text-base font-semibold text-white', className)} {...props} />; }
export function CardDescription({className, ...props}: React.HTMLAttributes<HTMLParagraphElement>) { return <p className={cn('mt-1 text-sm text-slate-400', className)} {...props} />; }
export function CardContent({className, ...props}: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn('p-5 pt-3', className)} {...props} />; }

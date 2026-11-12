import * as React from 'react';
import {cn} from '@/lib/utils';
export function Table({className, ...props}: React.TableHTMLAttributes<HTMLTableElement>) { return <div className="overflow-x-auto"><table className={cn('w-full text-sm', className)} {...props} /></div>; }
export function Th({className, ...props}: React.ThHTMLAttributes<HTMLTableCellElement>) { return <th className={cn('border-b border-slate-800 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500', className)} {...props} />; }
export function Td({className, ...props}: React.TdHTMLAttributes<HTMLTableCellElement>) { return <td className={cn('border-b border-slate-800/70 px-4 py-3 align-top text-slate-300', className)} {...props} />; }

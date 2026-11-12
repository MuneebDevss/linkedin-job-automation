'use client';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {createContext, useCallback, useContext, useState} from 'react';
import {CheckCircle2, X} from 'lucide-react';

const ToastContext = createContext<(message: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function Providers({children}: {children: React.ReactNode}) {
  const [queryClient] = useState(() => new QueryClient({defaultOptions: {queries: {staleTime: 1_000, retry: 1, refetchOnWindowFocus: true}}}));
  const [toasts, setToasts] = useState<Array<{id: string; message: string}>>([]);
  const toast = useCallback((message: string) => {
    const id = crypto.randomUUID();
    setToasts(items => [...items, {id, message}]);
    setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 4500);
  }, []);
  return <QueryClientProvider client={queryClient}><ToastContext.Provider value={toast}>{children}
    <div className="fixed bottom-5 right-5 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map(item => <div key={item.id} className="flex items-start gap-3 rounded-xl border border-cyan-500/30 bg-slate-900 p-4 text-sm text-slate-100 shadow-2xl"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-cyan-400" /><span className="flex-1">{item.message}</span><button onClick={() => setToasts(items => items.filter(toast => toast.id !== item.id))} aria-label="Dismiss"><X className="size-4" /></button></div>)}
    </div>
  </ToastContext.Provider></QueryClientProvider>;
}

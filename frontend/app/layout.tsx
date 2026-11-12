import type {Metadata} from 'next';
import './globals.css';
import {Providers} from '@/components/providers';
import {AppShell} from '@/components/app-shell';

export const metadata: Metadata = {title: 'Job Control Dashboard', description: 'Local LinkedIn application automation dashboard'};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body><Providers><AppShell>{children}</AppShell></Providers></body></html>;
}

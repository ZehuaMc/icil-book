import type { Metadata } from 'next';
import './globals.css';
import './time-slots.css';
export const metadata: Metadata = { title: '自习室 · 工位预约', description: '自习室工位预约平台。' };
export default function RootLayout({ children }: Readonly<{
    children: React.ReactNode;
}>) { return <html lang="zh-CN"><body>{children}</body></html>; }

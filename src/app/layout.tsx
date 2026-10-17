import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: '工位 · 教学空间预约', description: '让每一次学习，都有一个好位置。教学工位与课程预约平台。' };
export default function RootLayout({ children }: Readonly<{
    children: React.ReactNode;
}>) { return <html lang="zh-CN"><body>{children}</body></html>; }

import type { NextConfig } from 'next';
const config: NextConfig = { poweredByHeader: false, serverExternalPackages: ['@prisma/client'], experimental: { cpus: 2 } };
export default config;

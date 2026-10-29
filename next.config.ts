import type { NextConfig } from 'next';
const config: NextConfig = { poweredByHeader: false, distDir: process.env.NEXT_DIST_DIR || '.next', serverExternalPackages: ['@prisma/client'], experimental: { cpus: 2 } };
export default config;

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prisma = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

for (const args of [
    ['db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
    ['db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/constraints.sql'],
]) {
    const result = spawnSync(process.execPath, [prisma, ...args], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

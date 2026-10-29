import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const required = ['DATABASE_URL', 'ADMIN_STUDENT_ID', 'ADMIN_PASSWORD'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error(`完整验证需要专用测试数据库及管理员配置。缺少环境变量：${missing.join(', ')}。参见 README.md。`);
    process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 10) {
    console.error('ADMIN_PASSWORD 至少需要 10 位字符。');
    process.exit(1);
}
if (!existsSync('node_modules/.bin/prisma')) {
    console.error('依赖尚未安装。请先运行 npm install，然后运行 npm run verify。');
    process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const step of ['db:generate', 'db:validate', 'db:migrate', 'db:seed', 'typecheck', 'test', 'test:api', 'test:database', 'test:integration', 'build', 'test:e2e']) {
    console.log(`\n>>> ${step}`);
    const code = await new Promise((resolve, reject) => {
        const child = spawn(npm, ['run', step], { stdio: 'inherit', env: { ...process.env, E2E_SERVER_COMMAND: 'npm start', COOKIE_SECURE: 'false' } });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
    });
    if (code) process.exit(code);
}
console.log('\n完整验证通过：数据库迁移、种子、类型、规则、并发、生产构建与浏览器流程。');

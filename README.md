# 工位 · 教学空间预约

中文教学工位预约 MVP，使用 Next.js App Router、React、PostgreSQL、Prisma 和 TypeScript。家具用于展示，座位用于预约；成员按每段 30 分钟自由多选时段。

当前实现、未完成工作和未验证项见 [交接文档](HANDOFF.md)。

## 本地启动

需要 Node.js 22.10+、npm，以及 PostgreSQL 17（可使用 Docker Compose）。

```bash
cp .env.example .env
# 修改 .env 中的数据库连接、ADMIN_STUDENT_ID 和 ADMIN_PASSWORD
npm ci
npm run db:generate
docker compose up -d --wait
npm run db:init
npm run db:seed
npm run dev
```

打开 http://localhost:3000。也可以将 `DATABASE_URL` 指向现有 PostgreSQL，无需 Docker。

种子数据只创建 `.env` 中配置的管理员账号，不创建示例学员或助教：

| 账号 | 角色 |
| --- | --- |
| `ADMIN_STUDENT_ID` | 管理员 |

初始化包含一个场地和 24 个座位（其中一个停用）。成员可以自行注册；管理员可在用户管理中设置统一身份（管理员、助教、一生一芯成员或 ICIL 成员）。重复执行 seed 会按环境变量更新管理员密码和资料，不会创建成员账号。

所有身份统一使用学号和密码登录，系统按账号身份进入对应页面。成员注册后默认是一生一芯成员；助教与成员均直接选择日期、半小时时间和工位，无需后台创建或开放预约时段。

```bash
npm run build
npm start
```

生产环境使用 HTTPS，默认设置 Secure、HttpOnly、SameSite=Lax 的登录 Cookie。仅在本机通过 HTTP 验证生产构建时，可在 `.env` 设置 `COOKIE_SECURE=false`。反向代理部署设置 `APP_ORIGIN=https://实际域名`，用于校验写请求来源。

## 页面

| 路径 | 功能 |
| --- | --- |
| `/` | 日期、预约时段、交互座位地图、确认预约 |
| `/login`、`/register` | 统一登录、注册；新用户默认为一生一芯成员 |
| `/my-reservations` | 有效、已结束、已取消的预约记录 |
| `/assistant/sessions` | 兼容旧链接，进入助教选座预约页面 |
| `/admin` | 统计与配置入口 |
| `/admin/users` | 用户搜索、身份、启停 |
| `/admin/layouts` | 场地、画布编辑、批量编号、版本发布 |
| `/admin/booking-blocks` | 禁止预约时间：任意范围、整天禁止、解除禁止 |
| `/admin/reservations` | 工位预约记录、日期筛选、取消、CSV 导出 |
| `/admin/logs` | 管理修改和预约行为日志 |

布局编辑支持拖拽、家具宽高调整、旋转（保存时检查完整边界）、画布缩放、Shift 多选座位、批量编号、座位停用与桌面归属。选中桌面后添加座位会自动关联；拖动桌面会带动关联座位。方向键可微调选中元素。发布时保存草稿快照，已发布版本不可修改，复制为新版本后再编辑。

## 规则与一致性

- 所有显示和表单时间均使用 `Asia/Shanghai`，数据库使用 PostgreSQL `timestamptz`。
- 一生一芯成员所选完整时间必须已有同场地、启用中的助教实际预约工位。多个助教的相邻预约可以接续覆盖，部分重叠或中间有空隙不算覆盖；管理员工位预约和历史保障登记不提供此资格。
- 每段 30 分钟，可多选连续或不连续时段，同一天可多次预约；同一用户或工位的有效预约不可时间重叠。
- 预约、取消及助教变更使用 Serializable 事务，并锁定场次行；序列化冲突自动重试。用户和工位的时间排斥约束提供数据库层的最终防线。
- 取消以 `cancelledAt` 保留历史并释放预约时段。使用 `npm run db:init` 按当前 Prisma 模型创建数据库，并自动添加 `prisma/constraints.sql` 中的时间排斥与校验约束；无需逐版本升级。
- 账号分为一生一芯成员、ICIL 成员、助教和管理员。助教直接预约工位，允许选择助教固定工位；成员不可选固定工位。
- ICIL 成员无需助教预约或后台开放，可直接选择空闲工位。成员保留最多提前一天的预约范围。
- 管理员可设置任意时间范围或整天禁止预约，无需已有时段。禁止时间对所有身份生效；与其重叠的有效预约会取消并发送通知。解除禁止不会自动恢复已取消的预约。
- 助教取消预约、降级、停用或注销后，失去完整覆盖的一生一芯预约会自动取消并通知；ICIL 及仍有完整助教覆盖的预约保留。
- 预约规则页面、接口及每周/指定日期权限校验已移除，账号注册不再依赖默认分组；旧规则数据仅保留作数据库兼容，不参与预约判断。
- 预约开始后不能新约或自行取消。打卡功能及未打卡自动取消逻辑已移除；历史打卡列只为现有数据库兼容保留，Prisma 忽略该列。
- 已登录页面展示不替代服务端授权。所有后台接口检查管理员角色，普通取消检查所有者。管理员不可禁用或降级最后一个启用的管理员。
- 密码通过 bcrypt 散列；登录令牌为随机值，数据库仅存储令牌 SHA-256；登录会话七天过期。登录接口按账号在数据库计数，15 分钟最多 15 次；写接口拒绝跨站请求。CSV 对公式前缀做转义。
- 列表默认限制：禁止预约记录与用户 500 条、预约列表 5000 条、个人记录与日志 200 条；CSV 导出包含当前筛选下的全部座位预约。面向更大规模时可继续加入分页。

## 接口

全部位于 `src/app/api/[...path]/route.ts`，JSON 错误格式为 `{ "error": "中文说明" }`。

| 方法 / 路径 | 权限与用途 |
| --- | --- |
| POST `/api/auth/register`、`/api/auth/login` | 注册 / 登录 |
| POST `/api/auth/logout` | 注销并撤销当前会话 |
| GET `/api/auth/me` | 当前用户或 null |
| GET `/api/sessions` | 公开场次、家具、座位、脱敏预约状态 |
| GET / POST `/api/reservations` | 我的记录 / 选座 `{sessionId, seatId, startsAt, endsAt}` |
| POST `/api/reservations/batch` | 同一工位多段预约 `{sessionId, seatId, slots: [{startsAt, endsAt}]}` |
| DELETE `/api/reservations/:id` | 本人或管理员取消 |
| GET / POST `/api/layouts`，PUT `/api/layouts/:id` | 管理员布局列表 / 创建 / 保存 |
| POST `/api/layouts/venues` | 创建场地 |
| POST `/api/layouts/:id/publish` | 发布布局 |
| GET / POST `/api/admin/booking-blocks` | 管理员查询 / 创建禁止预约时间 `{startsAt, endsAt, reason}` |
| DELETE `/api/admin/booking-blocks/:id` | 管理员解除禁止预约时间 |
| GET `/api/admin/stats`、`/users`、`/logs` | 后台数据 |
| PATCH `/api/admin/users/:id` | 更新用户身份与状态 |
| GET `/api/admin/reservations?sessionId=...&export=csv` | 查询 / 导出预约 |

## 验证

无需安装依赖即可运行时间、请求处理与几何测试（Node 22.10+）：

```bash
npm test
```

安装依赖并初始化数据库后：

```bash
npm run typecheck
npm run test:api
npm run test:database
npm run test:notifications
npm run build
# 集成测试使用 DATABASE_URL 中的数据库，创建并清理独立测试数据
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

集成测试覆盖：完整助教预约覆盖、自动日期入口权限、ICIL 直接预约、禁止时间、批量原子性、并发抢座、助教取消联动和数据库冲突约束。Playwright 覆盖统一登录、助教选座后成员预约、全天禁止及解除、无打卡、CSV 导出、移动端和布局编辑发布。

建议在独立测试数据库初始化并 seed 后运行浏览器测试；浏览器测试使用 `.env.test` 的 `ADMIN_STUDENT_ID` 和 `ADMIN_PASSWORD`，成员账号由测试自行创建并清理。未提供数据库或管理员配置时验证直接失败，不会静默跳过。

完整验证入口会顺序执行 Prisma 生成与模型检查、数据库结构创建与初始化、TypeScript 检查、单元与接口测试、空库及重复初始化检查、数据库集成、取消通知、生产构建，并使用生产服务器运行 Playwright。仓库中的全部 7 个 Node 测试文件和 2 个 Playwright 文件均纳入验证；遇到失败立即停止，浏览器失败保留 trace 与 HTML 报告。

```bash
# 测试数据库独立使用 5433 端口和临时存储，不使用开发数据库的数据卷
cp .env.test.example .env.test
npm ci
npx playwright install --with-deps chromium
docker compose -f docker-compose.test.yml up -d --wait
npm run verify
# 完成后清理临时测试数据库
docker compose -f docker-compose.test.yml down
```

`verify` 从 `.env.test` 读取配置，CI 也可直接注入环境变量。该命令会创建数据库结构并初始化配置的数据库，请指向专用测试数据库。单独的 `db:seed`、`test:api`、`test:database`、`test:integration`、`test:notifications` 和 `test:e2e` 从 `.env` 读取配置；也可用 `node --env-file=.env.test --run test:api` 等命令明确使用测试配置。`E2E_SERVER_COMMAND="npm start"` 可单独测试已有生产构建；`COOKIE_SECURE=false` 仅用于本地 HTTP 验证。默认 Playwright 启动新服务器，避免复用配置不同的开发进程；如确需复用，可显式设置 `E2E_REUSE_SERVER=true`。

[自动验证工作流](.github/workflows/verify.yml) 已配置 PostgreSQL 17、Node.js 22 与 Chromium，使用 `package-lock.json` 和 `npm ci` 安装依赖，运行同一 `npm run verify` 并上传浏览器测试证据。

本机完整 `npm run verify` 验证记录（2026-11-08）：

- 17 个时间、请求与几何单元测试，20 个接口处理器测试（含 3 个账号变更子测试）。
- 独立空 schema 建库、重复初始化及 seed、管理员密码验证、时间排斥与区间校验约束检查。
- PostgreSQL 的 15 个预约/取消/助教/并发子场景（含父测试统计为 16），以及独立的取消通知测试。
- 17 个 Playwright 验收场景，其中 7 个使用 Chromium 页面交互，10 个通过真实 HTTP 检查权限、Cookie、CSV、并发和输入校验。
- 生产构建、真实 `npm start` 服务与 Docker PostgreSQL 同时参与；无失败、无跳过。

报告见 [验收记录](reports/ACCEPTANCE.md)、[完整日志](reports/verify.log) 和 `playwright-report/index.html`。浏览器截图随 HTML 报告保存；失败时额外保存截图与 trace。CI 配置会在推送后运行同一验证并上传报告；仓库远端为 `git@github.com:ZehuaMc/icil-book.git`，实际 CI 结果请以 GitHub Actions 运行记录为准。

应用容器、数据库持久化、Caddy HTTPS、健康检查、重启和备份恢复说明见 [部署文档](DEPLOYMENT.md)。本机运行地址为 http://localhost:3100；部署账号密码保存在仅本机使用的 `.env.deploy`。

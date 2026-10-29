# 工位 · 教学空间预约

中文教学工位预约 MVP，使用 Next.js App Router、React、PostgreSQL、Prisma 和 TypeScript。家具用于展示，座位用于预约；助教先登记现场保障，达到人数要求后学员才可选座。

当前实现、未完成工作和未验证项见 [交接文档](HANDOFF.md)。

## 本地启动

需要 Node.js 22.10+、npm，以及 PostgreSQL 17（可使用 Docker Compose）。

```bash
cp .env.example .env
# 修改 .env 中的数据库连接、ADMIN_STUDENT_ID 和 ADMIN_PASSWORD
npm ci
npm run db:generate
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

打开 http://localhost:3000。也可以将 `DATABASE_URL` 指向现有 PostgreSQL，无需 Docker。

种子数据只创建 `.env` 中配置的管理员账号，不创建示例学员或助教：

| 账号 | 角色 |
| --- | --- |
| `ADMIN_STUDENT_ID` | 管理员 |

初始化包含一个场地、24 个座位（其中一个停用），并创建“一生一芯成员”和“ICIL成员”权限分组。成员可以自行注册；管理员可在用户管理中设置成员类型、助教或管理员角色。重复执行 seed 会按环境变量更新管理员密码和资料，不会创建成员账号。

登录使用学号和密码。成员注册后默认是一生一芯成员；一生一芯成员必须有助教在对应时段登记保障或预约助教工位后才能预约，ICIL成员按全天入口预约。

```bash
npm run build
npm start
```

生产环境使用 HTTPS，默认设置 Secure、HttpOnly、SameSite=Lax 的登录 Cookie。仅在本机通过 HTTP 验证生产构建时，可在 `.env` 设置 `COOKIE_SECURE=false`。反向代理部署设置 `APP_ORIGIN=https://实际域名`，用于校验写请求来源。

## 页面

| 路径 | 功能 |
| --- | --- |
| `/` | 日期、预约时段、交互座位地图、确认预约 |
| `/login`、`/register` | 登录、注册；新用户自动进入默认分组 |
| `/my-reservations` | 有效、已结束、已取消的预约记录 |
| `/assistant/sessions` | 助教现场保障登记与取消 |
| `/admin` | 统计与配置入口 |
| `/admin/users` | 用户搜索、角色、分组、启停 |
| `/admin/groups` | 默认分组、每周规则、指定日期覆盖 |
| `/admin/layouts` | 场地、画布编辑、批量编号、版本发布 |
| `/admin/sessions` | 自习室时间、布局绑定、助教门槛、开放状态 |
| `/admin/reservations` | 座位和保障记录、场次筛选、取消、CSV 导出 |
| `/admin/logs` | 管理修改和预约行为日志 |

布局编辑支持拖拽、家具宽高调整、旋转（保存时检查完整边界）、画布缩放、Shift 多选座位、批量编号、座位停用与桌面归属。选中桌面后添加座位会自动关联；拖动桌面会带动关联座位。方向键可微调选中元素。发布时保存草稿快照，已发布版本不可修改，复制为新版本后再编辑。

## 规则与一致性

- 所有显示和表单时间均使用 `Asia/Shanghai`，数据库使用 PostgreSQL `timestamptz`。
- 分组需启用预约权限，且规则需覆盖完整预约时段。每周规则中的 0 表示周日。无匹配规则时禁止预约。
- 存在指定日期规则时，完全替代当日每周规则；禁止窗口与预约时段相交则拒绝，允许窗口需覆盖整场。可创建多个日期时间窗。
- 一名用户每场只能有一个有效座位预约；同一场次的同一座位只能有一条有效预约。
- 预约、取消及助教变更使用 Serializable 事务，并锁定场次行；序列化冲突自动重试。两个部分唯一索引提供数据库层的最终防线。
- 取消以 `cancelledAt` 保留历史，立即释放有效预约唯一约束。**请使用迁移，不要用 `prisma db push` 替代迁移**，部分唯一索引由 SQL 迁移维护。
- 账号分为一生一芯成员、ICIL成员、助教和管理员；助教保障使用独立的 `ASSISTANT` 角色，不消耗成员座位。
- 一生一芯成员只有在对应时段存在助教保障后才能预约；管理员单独开放时段不满足该条件。
- 只要存在有效学员预约，就禁止取消任何助教保障登记。需要变更角色或禁用助教时，必须先处理未来的保障登记。
- 预约时段开始后不能新约或取消。场次关闭后停止新增预约，已有预约可在开始前取消。
- 存在学员预约历史（包括已取消）或当前助教登记时，场次的时间和布局不可变更。可关闭预约入口；有学员预约时，提高助教门槛不能使现有保障人数不足。
- 同一场地不能创建时间重叠的开放场次，检查在 Serializable 事务内执行。
- 已登录页面展示不替代服务端授权。所有后台接口检查管理员角色，普通取消检查所有者。管理员不可禁用或降级最后一个启用的管理员。
- 密码通过 bcrypt 散列；登录令牌为随机值，数据库仅存储令牌 SHA-256；登录会话七天过期。登录接口按账号在数据库计数，15 分钟最多 15 次；写接口拒绝跨站请求。CSV 对公式前缀做转义。
- 列表默认限制：公开未来场次 100 条、后台场次与用户 500 条、预约列表 5000 条、个人记录与日志 200 条；CSV 导出包含当前筛选下的全部座位预约。面向更大规模时可继续加入分页。

## 接口

全部位于 `src/app/api/[...path]/route.ts`，JSON 错误格式为 `{ "error": "中文说明" }`。

| 方法 / 路径 | 权限与用途 |
| --- | --- |
| POST `/api/auth/register`、`/api/auth/login` | 注册 / 登录 |
| POST `/api/auth/logout` | 注销并撤销当前会话 |
| GET `/api/auth/me` | 当前用户或 null |
| GET `/api/sessions` | 公开场次、家具、座位、脱敏预约状态 |
| GET / POST `/api/reservations` | 我的记录 / 选座 `{sessionId, seatId}` |
| DELETE `/api/reservations/:id` | 本人或管理员取消 |
| POST `/api/reservations/coverage` | 助教登记 `{sessionId}` |
| DELETE `/api/reservations/coverage/:id` | 本人或管理员取消保障 |
| GET / POST `/api/groups`，PUT `/api/groups/:id` | 管理员分组与规则 |
| GET / POST `/api/layouts`，PUT `/api/layouts/:id` | 管理员布局列表 / 创建 / 保存 |
| POST `/api/layouts/venues` | 创建场地 |
| POST `/api/layouts/:id/publish` | 发布布局 |
| POST `/api/sessions`，PUT `/api/sessions/:id` | 管理员创建 / 修改场次 |
| GET `/api/admin/stats`、`/users`、`/sessions`、`/logs` | 后台数据 |
| PATCH `/api/admin/users/:id` | 更新用户角色、分组与状态 |
| GET `/api/admin/reservations?sessionId=...&export=csv` | 查询 / 导出预约 |

## 验证

无需安装依赖即可运行时间权限与请求处理测试（Node 22.10+）：

```bash
npm test
```

安装依赖并迁移数据库后：

```bash
npm run typecheck
npm run test:api
npm run build
# 集成测试使用 DATABASE_URL 中的数据库，创建并清理独立测试数据
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

集成测试覆盖：助教门槛、角色检查、停用座位、同座并发竞争、同人并发竞争、取消释放、数据库唯一约束、禁用账号、分组限制、已开始场次。Playwright 覆盖注册登录、助教登记、学员选座、管理员查看和导出，以及布局编辑发布、场次绑定、权限拒绝。

建议在独立测试数据库迁移并 seed 后运行浏览器测试；浏览器测试使用 `.env.test` 的 `ADMIN_STUDENT_ID` 和 `ADMIN_PASSWORD`，成员账号由测试自行创建并清理。未提供数据库或管理员配置时验证直接失败，不会静默跳过。

完整验证入口会顺序执行 Prisma 生成与模型检查、数据库迁移与初始化、TypeScript 检查、单元测试、空库及重复初始化检查、数据库集成、生产构建，并使用生产服务器运行 Playwright。遇到失败立即停止，浏览器失败保留 trace 与 HTML 报告。

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

`verify` 从 `.env.test` 读取配置，CI 也可直接注入环境变量。该命令会迁移并初始化配置的数据库，请指向专用测试数据库。单独的 `db:seed`、`test:integration` 和 `test:e2e` 仍从 `.env` 读取配置。`E2E_SERVER_COMMAND="npm start"` 可单独测试已有生产构建；`COOKIE_SECURE=false` 仅用于本地 HTTP 验证。默认 Playwright 启动新服务器，避免复用配置不同的开发进程；如确需复用，可显式设置 `E2E_REUSE_SERVER=true`。

[自动验证工作流](.github/workflows/verify.yml) 已配置 PostgreSQL 17、Node.js 22 与 Chromium，使用 `package-lock.json` 和 `npm ci` 安装依赖，运行同一 `npm run verify` 并上传浏览器测试证据。

本机已实际通过完整 `npm run verify`（2026-10-16）：

- 21 个规则、请求与几何单元测试，5 个接口处理器测试。
- 空 schema 真实迁移、两个部分唯一索引、迁移与模型差异检查、两次 migrate/seed，并确认人工修改和已取消保障不被覆盖。
- PostgreSQL 的 13 个预约/取消/助教/并发子场景。
- 16 个 Playwright 验收场景，其中 6 个使用 Chromium 页面交互，10 个通过真实 HTTP 检查权限、Cookie、CSV、并发和输入校验。
- 生产构建、真实 `npm start` 服务与 Docker PostgreSQL 同时参与；无失败、无跳过。

报告见 [验收记录](reports/ACCEPTANCE.md)、[完整日志](reports/verify.log) 和 `playwright-report/index.html`。浏览器截图随 HTML 报告保存；失败时额外保存截图与 trace。CI 配置会在推送后运行同一验证并上传报告；仓库远端为 `git@github.com:ZehuaMc/icil-book.git`，实际 CI 结果请以 GitHub Actions 运行记录为准。

应用容器、数据库持久化、Caddy HTTPS、健康检查、重启和备份恢复说明见 [部署文档](DEPLOYMENT.md)。本机运行地址为 http://localhost:3100；部署账号密码保存在仅本机使用的 `.env.deploy`。

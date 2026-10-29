# 教学工位预约系统交接文档

更新日期：2026-10-16。本文件已根据本次真实 Docker/PostgreSQL/Chromium 执行结果更新。

## 当前结论

**已跑通真实 PostgreSQL、Next.js 生产服务与 Chromium 同时参与的完整验证。** 原交接中的 Docker、监听端口和浏览器下载阻塞已解除。核心 MVP 可以在本机运行，关键并发、权限、布局和后台交互已有实际通过记录。

应用 Docker 镜像、独立持久数据库、迁移任务、健康检查、Caddy HTTPS 配置、备份与安全恢复脚本均已补齐。公网部署尚需实际域名与服务器；Git 远端已配置为 `git@github.com:ZehuaMc/icil-book.git`，GitHub Actions 结果待推送后确认。没有将本机成功描述为公网或 CI 成功。

## 已完成与证据

| 检查 | 本次实际结果 | 证据 |
| --- | --- | --- |
| 锁文件安装 | 本机 npm ci 成功；Node 22 容器中普通 npm ci 和安装脚本成功 | Docker 构建日志 |
| Prisma 生成、模型校验、类型检查、生产构建 | 全部通过 | reports/verify.log |
| 规则/请求/几何单元 | 21 通过，无跳过 | reports/verify.log |
| 接口处理器 | 5 通过，无跳过 | reports/verify.log |
| 空数据库初始化 | 独立随机 schema 执行迁移/seed，再执行迁移/seed；保留人工修改、密码、默认组、布局、场次和取消的保障 | tests/database.test.ts，日志中 1 个主测试 |
| 迁移结构 | Prisma migrate diff 无差异；实际存在两个有效预约部分唯一索引 | reports/reservation-indexes.txt |
| PostgreSQL 集成 | 原有 13 个顺序子场景通过；Node 统计包括父测试为 14 | tests/integration.test.ts |
| 真实 HTTP 与 Chromium | 16 场景通过，无跳过；6 个页面交互、10 个 HTTP 场景 | reports/playwright.json，playwright-report/index.html |
| 容器部署 | Node 22 多阶段构建，非 root 运行，数据库不暴露宿主端口，迁移成功后启动应用 | Dockerfile、docker-compose.deploy.yml |
| 运行健康 | /api/health 检查真实数据库连接 | 本机 HTTP/HTTPS 冒烟检查 |
| 重启与恢复 | app/postgres 重启后保留 3 用户、24 座位、21 场次；备份恢复到独立库并保留两个有效唯一索引 | reports/ACCEPTANCE.md |
| HTTPS | Caddy 配置与本机 TLS 冒烟检查见验收记录 | docker-compose.https.yml、scripts/deployment-smoke.mjs |
| CI | 已更新工作流和证据上传；未远端触发 | .github/workflows/verify.yml |

## 本次修复

1. 浏览器正常注册/登录被来源校验误拒：Next 生产请求内部 URL 可能使用 localhost，浏览器使用 127.0.0.1。现在按 Host 对照协议与端口，反向代理通过显式 APP_ORIGIN 配置公网地址；继续拒绝跨站和不同端口，不信任转发头来决定允许来源。
2. 重复 seed 会补回已取消助教保障：现在只对新建示例早场初始化保障；不替停用或已降级用户登记，不修改已有账号或场次。
3. 测试与开发 Compose 默认项目名冲突：测试项目固定为 teaching-station-test，部署为 teaching-station-deploy，分别使用 tmpfs 与持久卷。
4. 布局原来只校验 x/y：现在校验尺寸和旋转后的完整外接范围，拒绝关联到文字/分隔物；桌面连同关联座位拖动时整体限位，保留相对位置。
5. 窄屏隐藏账号入口：现在顶部保留登录/退出入口；修复窄屏提示卡片异常拉长。
6. 已登录角色/分组资料滞后：导航、页面聚焦、恢复可见及每 20 秒刷新当前用户。服务端每次请求仍重新授权。
7. 对话框键盘交互：统一焦点进入/循环/恢复与 Escape 关闭，后台、布局和预约确认使用同一组件。
8. 全部学员预约取消后可改变历史场次：现在只要存在学员预约历史，仍锁定时间/布局；提高助教门槛仅按有效预约判断。

## 验收范围

原 13 个数据库子场景：助教门槛、助教角色、重复登记、停用/异布局座位、同座/同人并发、取消释放、助教移除竞争、停用账号、禁止分组、直接写库唯一约束和开始时间限制均通过。

新增验收包含：最后管理员同时降级/停用保护；重叠场次并发只成功一个且允许相邻；助教登记与降级/停用竞争；保存/发布竞争及复制新版本隔离；有历史预约时预约时间/布局限制；关闭重开；管理员取消与失败事务无成功日志；已登录角色与分组立即生效；CSV 筛选/BOM/中文/引号换行/公式前缀；登录 Cookie、7 天期限、过期/撤销、15 次限流与过期窗口重置；非法日期和布局输入。

页面交互包括：注册登录、助教保障、选座、我的预约、后台筛选/CSV；布局新建/编辑/发布/只读；用户、分组日期规则、场次创建和管理员取消表单；768×1024 触屏与 390×844 窄屏；座位键盘操作和确认框焦点；两个独立浏览器抢座、刷新、取消释放及请求失败重试；画布拖动、缩放、尺寸旋转、关联桌椅、多选编号。HTML 报告包含截图。

## 运行入口

项目根目录 `/home/zehua/icil_book`。本机 Node 24.20.0；Docker 构建基于 Node 22，均通过。

- 应用：http://localhost:3100。
- 管理员：admin@station.local；助教：assistant@station.local；学员：learner@station.local。
- 密码来自 `.env.deploy` 的 SEED_PASSWORD，本机生成随机值，文件权限 600，不写入报告。
- 健康检查：GET /api/health。
- 运行、重启、HTTPS、备份恢复命令：[DEPLOYMENT.md](DEPLOYMENT.md)。
- 测试报告：[reports/ACCEPTANCE.md](reports/ACCEPTANCE.md)，完整日志 reports/verify.log，浏览器 playwright-report/index.html。

### 再次验证

```bash
# 保留已有 .env.test；未配置时从 .env.test.example 复制
npx playwright install --with-deps chromium
docker compose -f docker-compose.test.yml up -d --wait
npm run verify
```

verify 依次执行生成、模型校验、迁移、seed、类型、21 单元、5 接口、空库/幂等检查、13 数据库子场景、生产构建及 16 Playwright 场景。配置缺失会失败，不会静默跳过。不要对运营库执行。

本机 Ubuntu 26.04 缺少 libnspr4/libnss3，本次已下载 Ubuntu 软件包并解压至用户目录，LD_LIBRARY_PATH 仅写入未跟踪的 .env.test；中文字体安装在用户字体目录。其他机器推荐运行 Playwright 的标准依赖安装命令。Docker 权限此前因当前会话未继承 docker 组而拒绝，用户已通过 socket ACL 修复；socket 重建后应重新登录使组权限生效。

## 仍需外部信息才能完成

- GitHub Actions 实跑：已初始化 Git 仓库，当前分支为 `master`，远端为 `git@github.com:ZehuaMc/icil-book.git`。工作流在推送后自动触发，实际结果和成功链接以远端运行记录为准。
- 公网 HTTPS：没有公网域名/服务器目标。已提供 Caddy 自动证书配置并做本机 TLS 检查；公网证书签发、DNS、防火墙和上线流量仍需在目标环境验收。

## 后续增强与保留限制

这些是后续产品/运营范围，不阻止现有 MVP 的本机验收：

- 无分页入口：公开场次 100、用户/后台场次 500、个人记录/日志 200、后台预约列表 5000 上限；CSV 不截断。
- 无完整删除/归档策略、场次内容快照、日志留存与导出。已锁定场次时间/布局，但这不等于完整历史快照。
- 编辑器无撤销/重做、缩放把手与多选整体拖动；旋转/尺寸属性造成越界时保存会拒绝，需用户调整。
- 无过期会话/限流记录定时清理、运营告警和自动备份调度；已有健康检查和可调用的备份脚本。
- 未做实物平板体验、浏览器全矩阵、长时间浸泡、高负载或多应用进程压力测试；已验 Chromium 触屏模拟与小规模并发。
- 后台创建/修改各表单覆盖核心路径，未穷举全部输入组合和所有并发调度；不能把测试通过理解为绝对无缺陷。

交付时已清理临时测试库；部署应用和持久数据库继续运行于本机 3100 端口。HTTPS 反代已验收后停止，后续启用命令见 DEPLOYMENT。验收报告与截图已保留。

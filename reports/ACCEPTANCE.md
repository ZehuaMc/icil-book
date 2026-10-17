# 2026-10-16 本机验收记录

最终完整验证：**PASS**。真实 PostgreSQL 17、Next.js 15.5.28 生产构建/服务与 Chromium 156 参与，无失败、无跳过。

| 项目 | 结果 |
| --- | --- |
| 生成 / Prisma 模型 / TypeScript / 生产构建 | 通过 |
| 单元测试 | 21 通过 |
| 接口处理器测试 | 5 通过 |
| 空库迁移、两次 migrate/seed、模型 diff、实际部分唯一索引 | 1 个主测试通过 |
| PostgreSQL 服务集成 | 13 个子场景通过（含父测试统计为 14） |
| Playwright | 16 通过；6 个浏览器交互、10 个真实 HTTP 场景 |
| Docker Node 22 构建及正常 npm ci | 通过 |
| Docker 迁移 / seed / app 健康检查 | 通过，运行用户 uid=1000(node) |
| PostgreSQL/app 重启保留数据 | 3 用户、24 座位、21 场次 |
| pg_dump / 独立库 pg_restore | 通过，同样数量及两个有效预约唯一索引 |
| HTTP Chromium 部署冒烟 | 登录、后台、跨站拒绝、HttpOnly/SameSite、退出成功 |
| 本机 Caddy HTTPS Chromium 部署冒烟 | 登录、后台、跨站拒绝、Cookie Secure=true、退出成功 |

最终 Playwright 机器结果：2026-10-16 14:24:27 UTC 开始，约 21.8 秒，expected=16、unexpected=0、skipped=0、flaky=0。完整命令见 `verify.log`，并非只运行测试列表。

## 证据文件

- [完整 verify 日志](verify.log)
- [Playwright JSON](playwright.json)
- [Playwright HTML](../playwright-report/index.html)
- [数据库索引](reservation-indexes.txt)
- [恢复演练](restore-drill.txt)
- [Docker 构建](docker-build.log)
- [HTTPS 冒烟](https-smoke.log)
- [HTTP 冒烟](http-smoke.log)
- [平板截图](screenshots/tablet-booking.png)
- [窄屏截图](screenshots/mobile-booking.png)
- [布局发布截图](screenshots/published-layout.png)
- [后台日志截图](screenshots/admin-logs.png)
- [部署 HTTP 截图](deployment-http.png)
- [部署 HTTPS 截图](deployment-https.png)

## 界面检查记录

本次使用真实 Chromium 自动操作，并查看了生成的窄屏、布局发布和后台截图。后台表单覆盖用户修改、分组日期规则、课程修改、场次创建、管理员取消学员与助教记录和日志查看。布局覆盖拖动桌椅、缩放、宽高、旋转、键盘微调、Shift 多选、批量编号、保存与发布后只读。确认框覆盖焦点进入、循环、Escape 关闭及焦点恢复。

768×1024 触屏模拟和 390×844 窄屏通过；窄屏无页面水平溢出，登录/退出可用。观察到提示卡片在窄屏被拉长，已修复并重新执行完整 verify。小规模抢座使用两个独立浏览器上下文，确认失败提示和刷新、取消释放、请求失败重试；不代替高负载或实物平板验收。

## 部署边界

本机 HTTPS 使用 Caddy 为 localhost 签发的本地证书；冒烟浏览器显式允许该证书。验证了真实 TLS 反代与 Secure Cookie，不代表公网 CA 信任链、DNS 或服务器上线验收。

本次验收时 GitHub Actions 尚未远端运行，没有成功运行链接。2026-10-17 整理提交时已确认 Git 仓库和远端 `git@github.com:ZehuaMc/icil-book.git`，CI 结果待推送后查看。公网部署缺真实域名和目标服务器。分页、归档、运营监控、定时清理和高并发压力测试作为后续增强，详见 HANDOFF。

部署示例账号密码来自本机 `.env.deploy`，不写入本报告；该配置权限 600。备份含数据库数据，位于受限 `backups/`，未纳入镜像或文档公开内容。

## 交付时状态

应用与部署 PostgreSQL 容器保持运行且健康，地址 http://localhost:3100。HTTPS 冒烟完成后停止并移除了本次 Caddy 容器，保留配置与证书卷；应用恢复本机 HTTP 配置。临时测试 PostgreSQL 已按交接要求停止/移除，测试日志、HTML/JSON 和截图保留。源文件校验值见 `source-sha256.json`。

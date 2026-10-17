# 运行与部署

## 本机 Docker 运行

应用、迁移与 PostgreSQL 使用独立的 `teaching-station-deploy` 项目和持久数据卷；不会复用 `teaching-station-test` 临时测试库。数据库不映射宿主机端口，应用默认只监听本机 `127.0.0.1:3100`。

```bash
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
# 编辑 DB_PASSWORD（建议随机十六进制）、SEED_PASSWORD 和 APP_ORIGIN
# 本机 HTTP：APP_ORIGIN=http://localhost:3100，COOKIE_SECURE=false
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build --wait
# 首次体验时手动初始化示例账号，正常重启不会自动 seed
docker compose --env-file .env.deploy -f docker-compose.deploy.yml run --rm migrate npm run db:seed
```

打开 http://localhost:3100。管理员邮箱为 `admin@station.local`，密码取 `.env.deploy` 的 `SEED_PASSWORD`。助教和学员邮箱见 README。`APP_ORIGIN` 必须与浏览器实际使用的协议、主机和端口一致。

镜像以非 root 用户运行。迁移任务成功后才启动应用；`/api/health` 同时检查 Web 服务和数据库连接。示例数据初始化是独立命令，重复运行保留既有账号、布局、场次及手动取消的助教保障。

```bash
docker compose --env-file .env.deploy -f docker-compose.deploy.yml ps
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs --tail=100 app
docker compose --env-file .env.deploy -f docker-compose.deploy.yml restart app
# 停止服务，保留数据库卷
docker compose --env-file .env.deploy -f docker-compose.deploy.yml down
```

## HTTPS

将域名解析到部署服务器，开放 80/443。在 `.env.deploy` 设置真实的 `SITE_ADDRESS`，然后运行：

```bash
docker compose --env-file .env.deploy -f docker-compose.deploy.yml -f docker-compose.https.yml up -d --build --wait
```

Caddy 自动申请与续期证书，代理到应用；叠加配置强制 `APP_ORIGIN=https://域名`、`COOKIE_SECURE=true`。证书存放在独立持久卷。公网域名、DNS 和防火墙需在实际服务器配置，本机运行不等于公网部署验收。

## 备份与恢复演练

```bash
bash scripts/backup.sh
bash scripts/restore.sh backups/station-时间.dump restore_drill_日期
```

备份使用 PostgreSQL 自带 `pg_dump -Fc`，文件权限只允许当前用户访问；失败不会留下看似成功的完整文件。恢复脚本只接受新建的 `restore_` 前缀数据库，已有同名数据库会拒绝，原运行库不会被覆盖。备份文件包含账号与预约数据，应保存到受限存储并另存一份到其他机器。

检查演练库（替换库名）：

```bash
docker compose --env-file .env.deploy -f docker-compose.deploy.yml exec -T postgres \
  psql -U station -d restore_drill_日期 -c 'SELECT count(*) FROM "User";'
```

定期备份可用系统定时任务调用 `scripts/backup.sh`，根据实际数据量设置保留周期。完整灾难切换需要先停写、恢复到新库、核对预约和有效唯一索引，再修改连接并启动；该切换不会由恢复脚本自动执行。

## 验证与证据

测试命令与当前验收结果见 README、HANDOFF 和 `reports/ACCEPTANCE.md`。完整验证使用专用测试数据库，不能指向运营库。Docker 部署数据库保留业务数据，浏览器测试会创建临时夹具并清理，因此日常回归仍使用 `.env.test`。

# PetDock Managed Service Shared Dev 部署指南

## 1. 文档状态

- 状态：Active
- 建立日期：2026-08-15
- 目标环境：单台中国大陆 Ubuntu 服务器
- 用途：Phase 2 多电脑共享开发数据库和中间件
- 接入方式：SSH 本地端口转发

本文档只部署 `shared-dev` 基础依赖，不开放官网、OIDC、控制面或 AI 数据面公网流量。不得把文档中的占位符替换为真实服务器地址、账号或密码后提交到仓库。

## 2. 已确认选型

| 领域 | 选型 | 当前版本线 |
| --- | --- | --- |
| 关系数据库 | PostgreSQL | 17 |
| 缓存与短期状态 | Redis | 8.0 |
| 数据库迁移 | Flyway | 随 `petdock-cloud` 固定 |
| 身份框架 | Spring Authorization Server | 随 `petdock-cloud` 固定 |
| 容器编排 | Docker Compose Plugin | 当前稳定版 |
| 入口网关 | Nginx | shared-dev 不开放公网；正式部署遵循 Cloud 生产与线上联调指南 |

当前不部署 Kafka、RabbitMQ、Elasticsearch、MinIO 或 PgBouncer。

## 3. 前置检查

以下命令假设服务器为 Ubuntu 22.04 或 24.04，并且当前账号可以使用 `sudo`。如果系统不是 Ubuntu，应停止执行 Docker 安装部分，改用对应发行版的官方安装方式。

```bash
cat /etc/os-release
uname -m
df -h /
free -h
timedatectl
```

### 3.1 时区策略

服务器操作系统使用中国标准时间，数据库、JWT、接口时间和应用内部继续统一使用 UTC：

| 层级 | 时区 | 原因 |
| --- | --- | --- |
| Ubuntu 主机 | `Asia/Shanghai` | 便于人工运维、系统日志查看和定时任务安排 |
| PostgreSQL Session 默认值 | UTC | 避免跨服务时间比较和夏令时语义差异 |
| Spring Boot、FastAPI | UTC | 保证接口、审计和跨进程事件一致 |
| JWT `iat`、`exp` | UTC Unix 秒 | 遵守 OAuth/JWT 契约 |
| Renderer 展示 | `Asia/Shanghai` | 面向中国大陆用户显示本地时间 |

设置 Ubuntu 主机时区：

```bash
sudo timedatectl set-timezone Asia/Shanghai
timedatectl
```

预期显示 `Time zone: Asia/Shanghai (CST, +0800)`。不要把 PostgreSQL Compose 配置中的 `timezone=UTC` 和 `log_timezone=UTC` 改成 `Asia/Shanghai`。

确认云平台安全组没有向公网开放以下端口：

```text
5432/tcp
6379/tcp
```

SSH 管理端口必须已经可以正常连接。修改防火墙或 SSH 配置时，不要关闭当前管理会话，直到新连接验证成功。

## 4. 安装 Docker 与 Compose

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

不要为了省略 `sudo` 把普通开发账号加入 `docker` 组。Docker 组具有接近 root 的主机权限。

## 5. 创建部署目录与密钥

```bash
sudo install -d -m 0750 /opt/petdock/shared-dev
sudo install -d -m 0755 /opt/petdock/shared-dev/postgres/init
sudo install -d -m 0750 /opt/petdock/shared-dev/backups/postgres
```

使用服务器本地随机源生成开发环境密码，不在终端打印明文：

```bash
sudo bash -c '
set -euo pipefail
cd /opt/petdock/shared-dev
umask 077
{
  echo "POSTGRES_ADMIN_PASSWORD=$(openssl rand -hex 32)"
  echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 32)"
  echo "POSTGRES_MIGRATE_PASSWORD=$(openssl rand -hex 32)"
  echo "POSTGRES_READONLY_PASSWORD=$(openssl rand -hex 32)"
  echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
} > .env
'
```

检查权限，不输出文件内容：

```bash
sudo stat -c '%a %U:%G %n' /opt/petdock/shared-dev/.env
```

预期权限为 `600 root:root`。

## 6. 创建 PostgreSQL 初始化脚本

```bash
sudo tee /opt/petdock/shared-dev/postgres/init/10-create-roles.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=migrate_password="$POSTGRES_MIGRATE_PASSWORD" \
  --set=readonly_password="$POSTGRES_READONLY_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE petdock_app_dev LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petdock_app_dev')
\gexec

SELECT format(
  'CREATE ROLE petdock_migrate_dev LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'migrate_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petdock_migrate_dev')
\gexec

SELECT format(
  'CREATE ROLE petdock_readonly_dev LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'readonly_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petdock_readonly_dev')
\gexec

ALTER ROLE petdock_app_dev PASSWORD :'app_password';
ALTER ROLE petdock_migrate_dev PASSWORD :'migrate_password';
ALTER ROLE petdock_readonly_dev PASSWORD :'readonly_password';

ALTER DATABASE petdock_shared_dev OWNER TO petdock_migrate_dev;
ALTER SCHEMA public OWNER TO petdock_migrate_dev;

GRANT CONNECT ON DATABASE petdock_shared_dev TO petdock_app_dev, petdock_readonly_dev;
GRANT USAGE ON SCHEMA public TO petdock_app_dev, petdock_readonly_dev;

ALTER DEFAULT PRIVILEGES FOR ROLE petdock_migrate_dev IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO petdock_app_dev;
ALTER DEFAULT PRIVILEGES FOR ROLE petdock_migrate_dev IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO petdock_app_dev;
ALTER DEFAULT PRIVILEGES FOR ROLE petdock_migrate_dev IN SCHEMA public
  GRANT SELECT ON TABLES TO petdock_readonly_dev;
ALTER DEFAULT PRIVILEGES FOR ROLE petdock_migrate_dev IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO petdock_readonly_dev;
SQL
EOF

sudo chmod 0755 /opt/petdock/shared-dev/postgres/init/10-create-roles.sh
sudo chown root:root /opt/petdock/shared-dev/postgres/init/10-create-roles.sh
```

容器内的 `postgres` 用户必须能够遍历初始化目录和执行脚本，因此目录与脚本需要至少具有其他用户的读取/执行权限：

```bash
sudo chmod 0755 /opt/petdock/shared-dev/postgres/init
sudo chmod 0755 /opt/petdock/shared-dev/postgres/init/10-create-roles.sh
```

该脚本会在 PostgreSQL 数据卷首次初始化时自动执行，并允许在初始化中断后手工安全重跑。不要通过删除已有数据卷来重复执行初始化脚本。

## 7. 创建 Docker Compose 配置

```bash
sudo tee /opt/petdock/shared-dev/compose.yaml > /dev/null <<'EOF'
name: petdock-shared-dev

services:
  postgres:
    image: postgres:17-bookworm
    container_name: petdock-shared-dev-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: petdock_admin
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: petdock_shared_dev
      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256
      POSTGRES_APP_PASSWORD: ${POSTGRES_APP_PASSWORD}
      POSTGRES_MIGRATE_PASSWORD: ${POSTGRES_MIGRATE_PASSWORD}
      POSTGRES_READONLY_PASSWORD: ${POSTGRES_READONLY_PASSWORD}
    command:
      - postgres
      - -c
      - password_encryption=scram-sha-256
      - -c
      - timezone=UTC
      - -c
      - log_timezone=UTC
    ports:
      - 127.0.0.1:5432:5432
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'
    networks:
      - internal

  redis:
    image: redis:8.0-bookworm
    container_name: petdock-shared-dev-redis
    restart: unless-stopped
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    command:
      - /bin/sh
      - -c
      - exec redis-server --appendonly yes --appendfsync everysec --requirepass "$${REDIS_PASSWORD}" --protected-mode yes
    ports:
      - 127.0.0.1:6379:6379
    volumes:
      - redis_data:/data
    healthcheck:
      test: [CMD-SHELL, 'REDISCLI_AUTH="$${REDIS_PASSWORD}" redis-cli ping | grep -q PONG']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'
    networks:
      - internal

volumes:
  postgres_data:
  redis_data:

networks:
  internal:
    driver: bridge
EOF

sudo chmod 0640 /opt/petdock/shared-dev/compose.yaml
sudo chown root:root /opt/petdock/shared-dev/compose.yaml
```

校验 Compose 展开结果时不要把输出复制到聊天或日志，因为展开结果包含密码：

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml config --quiet
```

## 8. 启动并验证服务

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml pull
sudo docker compose --env-file .env -f compose.yaml up -d
sudo docker compose --env-file .env -f compose.yaml ps
```

验证 PostgreSQL、Redis 和主机监听地址：

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml exec postgres pg_isready -U petdock_admin -d petdock_shared_dev
sudo docker compose --env-file .env -f compose.yaml exec redis sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
sudo ss -lntp | grep -E '127\.0\.0\.1:(5432|6379)'
```

预期结果：

- PostgreSQL 返回 `accepting connections`。
- Redis 返回 `PONG`。
- `5432` 和 `6379` 只显示在 `127.0.0.1`，不能显示为 `0.0.0.0` 或公网地址。

记录镜像摘要，便于后续锁定实际部署版本：

```bash
sudo docker image inspect postgres:17-bookworm --format '{{index .RepoDigests 0}}'
sudo docker image inspect redis:8.0-bookworm --format '{{index .RepoDigests 0}}'
```

### 8.1 初始化目录权限错误恢复

如果 PostgreSQL 日志出现以下错误：

```text
ls: cannot open directory '/docker-entrypoint-initdb.d/': Permission denied
```

先修复 bind mount 权限，不删除数据卷：

```bash
sudo chmod 0755 /opt/petdock/shared-dev/postgres/init
sudo chmod 0755 /opt/petdock/shared-dev/postgres/init/10-create-roles.sh
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml restart postgres
sudo docker compose --env-file .env -f compose.yaml logs --tail=100 postgres
```

容器恢复后检查三个开发角色是否已经创建：

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml exec -T postgres \
  psql -U petdock_admin -d petdock_shared_dev -Atc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('petdock_app_dev','petdock_migrate_dev','petdock_readonly_dev') ORDER BY rolname;"
```

如果输出不足三个角色，手工执行已经改为幂等的初始化脚本：

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml exec postgres \
  bash /docker-entrypoint-initdb.d/10-create-roles.sh
```

执行后再次检查角色和容器健康状态。只有在确认是全新环境、没有任何需要保留的数据且上述恢复仍失败时，才评估重建 PostgreSQL 数据卷；不要执行会同时删除 Redis 数据卷的 `docker compose down -v`。

## 9. 防火墙检查

如果服务器使用 UFW，先保证 SSH 已允许，再拒绝数据库端口：

```bash
sudo ufw allow OpenSSH
sudo ufw deny 5432/tcp
sudo ufw deny 6379/tcp
sudo ufw status verbose
```

如果 UFW 当前未启用，不要在无人值守或没有备用控制台时直接启用。先确认云平台安全组、SSH 端口和当前会话，再决定是否执行：

```bash
sudo ufw enable
```

## 10. 创建 SSH 隧道账号

```bash
sudo adduser --disabled-password --gecos '' petdock-tunnel
sudo install -d -m 0700 -o petdock-tunnel -g petdock-tunnel /home/petdock-tunnel/.ssh
sudo touch /home/petdock-tunnel/.ssh/authorized_keys
sudo chmod 0600 /home/petdock-tunnel/.ssh/authorized_keys
sudo chown petdock-tunnel:petdock-tunnel /home/petdock-tunnel/.ssh/authorized_keys
```

在每台 Windows 开发电脑分别生成独立密钥：

```powershell
ssh-keygen -t ed25519 -a 100 -f "$env:USERPROFILE\.ssh\petdock_shared_dev"
Get-Content "$env:USERPROFILE\.ssh\petdock_shared_dev.pub"
```

把每台电脑的公钥作为单独一行加入服务器的 `authorized_keys`。建议为每行增加转发限制：

```text
restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="127.0.0.1:6379" ssh-ed25519 <公钥正文> <电脑标识>
```

不要把私钥或真实公钥提交到仓库。

增加 SSH 用户级限制：

```bash
sudo tee /etc/ssh/sshd_config.d/90-petdock-tunnel.conf > /dev/null <<'EOF'
Match User petdock-tunnel
    PasswordAuthentication no
    AuthenticationMethods publickey
    AllowTcpForwarding local
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    PermitOpen 127.0.0.1:5432 127.0.0.1:6379
EOF

sudo sshd -t
sudo systemctl reload ssh
```

保持当前管理会话开启，直到隧道账号在另一终端验证成功。

## 11. Windows 开发机建立隧道

```powershell
ssh -i "$env:USERPROFILE\.ssh\petdock_shared_dev" -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 15432:127.0.0.1:5432 -L 16379:127.0.0.1:6379 petdock-tunnel@<服务器地址>
```

另开 PowerShell 验证本地端口：

```powershell
Test-NetConnection 127.0.0.1 -Port 15432
Test-NetConnection 127.0.0.1 -Port 16379
```

本地开发服务使用以下逻辑地址：

```text
PostgreSQL host: 127.0.0.1
PostgreSQL port: 15432
PostgreSQL database: petdock_shared_dev
Redis host: 127.0.0.1
Redis port: 16379
```

数据库密码和 Redis 密码从服务器 `/opt/petdock/shared-dev/.env` 受控获取后，保存到本机未提交的环境文件或系统凭据存储。不要把 `.env` 文件整体复制到代码仓库。

## 12. 创建 PostgreSQL 备份任务

```bash
sudo tee /opt/petdock/shared-dev/backup-postgres.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/petdock/shared-dev
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="backups/postgres/petdock_shared_dev-${timestamp}.dump"

docker compose --env-file .env -f compose.yaml exec -T postgres \
  pg_dump -U petdock_admin -d petdock_shared_dev -Fc > "$target"

chmod 0600 "$target"
find backups/postgres -type f -name '*.dump' -mtime +14 -delete
EOF

sudo chmod 0750 /opt/petdock/shared-dev/backup-postgres.sh
sudo chown root:root /opt/petdock/shared-dev/backup-postgres.sh
sudo /opt/petdock/shared-dev/backup-postgres.sh
sudo find /opt/petdock/shared-dev/backups/postgres -maxdepth 1 -type f -printf '%f %s bytes\n'
```

建立每日北京时间 03:20 备份：

```bash
sudo tee /etc/systemd/system/petdock-shared-dev-backup.service > /dev/null <<'EOF'
[Unit]
Description=PetDock shared-dev PostgreSQL backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/opt/petdock/shared-dev/backup-postgres.sh
EOF

sudo tee /etc/systemd/system/petdock-shared-dev-backup.timer > /dev/null <<'EOF'
[Unit]
Description=Run PetDock shared-dev PostgreSQL backup daily

[Timer]
OnCalendar=*-*-* 03:20:00 Asia/Shanghai
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now petdock-shared-dev-backup.timer
sudo systemctl list-timers petdock-shared-dev-backup.timer
systemd-analyze calendar '*-*-* 03:20:00 Asia/Shanghai'
```

当前备份仍位于同一主机，只能防止误操作，不能防止整机故障。下一阶段需要增加中国大陆境内的加密主机外备份。

## 13. 常用运维命令

```bash
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml ps
sudo docker compose --env-file .env -f compose.yaml logs --tail=100 postgres
sudo docker compose --env-file .env -f compose.yaml logs --tail=100 redis
sudo docker compose --env-file .env -f compose.yaml restart postgres redis
sudo docker compose --env-file .env -f compose.yaml stop
sudo docker compose --env-file .env -f compose.yaml start
```

升级前先备份，再拉取同一主版本的新镜像：

```bash
sudo /opt/petdock/shared-dev/backup-postgres.sh
cd /opt/petdock/shared-dev
sudo docker compose --env-file .env -f compose.yaml pull
sudo docker compose --env-file .env -f compose.yaml up -d
sudo docker compose --env-file .env -f compose.yaml ps
```

禁止在已有数据后执行以下命令，除非已经明确决定销毁整个共享开发环境并验证备份可恢复：

```text
docker compose down -v
docker volume rm ...
```

## 14. 部署完成后的回传信息

部署完成后只需记录和回传以下非敏感结果：

- Ubuntu 版本和 CPU 架构。
- Docker 与 Compose 版本。
- `docker compose ps` 中两个服务是否为 healthy。
- `ss` 是否只显示 `127.0.0.1:5432` 和 `127.0.0.1:6379`。
- PostgreSQL 与 Redis 镜像摘要。
- SSH 隧道端口测试是否成功。
- 首次 PostgreSQL 备份是否成功。

不要回传 `.env`、密码、公钥正文、服务器公网 IP、完整 SSH 命令历史或数据库连接串。

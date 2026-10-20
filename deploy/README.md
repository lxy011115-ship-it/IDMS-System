# idms.xin 服务器部署

当前阶段：备案前内部部署准备。网站仅监听服务器回环地址，不向公网开放。原商业生产发布门禁保留，完整方案 A 验收尚未完成。

## 目录与服务

- `/srv/idms/app`：本仓库的已验证发布副本；Node.js 24.20.0。
- `/srv/idms/private`：服务器生成的数据库和身份服务密钥，仅本机保存。
- 独立 PostgreSQL 16 容器 `idms-postgres`，只发布 `127.0.0.1:55434`。
- 独立 Keycloak 26.8.1 容器 `idms-keycloak`，只监听 `127.0.0.1:8084`。
- `idms-pilot.service`：以独立系统用户运行，网站 `127.0.0.1:4011`。
- 新建合成演示租户，未迁移原本机客户数据。AI 本地大模型、MQTT 及 Flowable 外部服务尚未在此小规格服务器部署；页面遵循既有未配置/人工处理规则。

`prepare-host.sh` 是新服务器目录的一次性准备脚本，拒绝覆盖已有私密配置或容器；执行前检查脚本及资源预算。`bootstrap.mjs` 使用既有迁移及共享加密会话模块创建独立数据库。密码在服务器生成，不能放进 GitHub。

## 检查

```sh
systemctl status idms-pilot --no-pager
curl -fsS http://127.0.0.1:4011/api/v1/health
curl -fsS http://127.0.0.1:4011/api/v1/auth/session
docker ps --filter name=idms-
```

备案完成后再启用 `idms.xin`/`www.idms.xin` 解析、申请公开可信 HTTPS 证书、切换 OIDC 的公开地址和严格回调地址，并完成真实浏览器登录、独立审批、备份恢复及外网验收。不得直接使用旧根目录 `docker-compose.yml` 作为生产部署方案。

`source-export.json` 记录导出的已发布代码摘要；根 README 使用此仓库的简明说明代替历史运行记录，部署文件为新增内容。v4 模块已归档，但尚未替换完整 v2 站点入口；未验证的维护控制台工作文件未发布。


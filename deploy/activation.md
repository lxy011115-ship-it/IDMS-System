# 备案完成后的接入步骤

此文档是待执行方案，不表示域名、证书或公网登录已生效。

1. 确认 idms.xin 的 ICP 备案已完成并接入阿里云，确认注册商及阿里云 DNS 权威 NS 状态一致。
2. 重新读取现有解析记录，按 `dns.pending.json` 设置根域 A 和 www CNAME，避免覆盖用户后续新增记录。
3. 为 idms.xin 和 www.idms.xin 申请可信 HTTPS 证书。只安装到 IDMS 独立证书目录；不修改其他站点证书。
4. 为现有代理容器建立仅内部可达的 IDMS 上游通道。网站与 Keycloak 当前只绑定宿主回环，不能直接把容器中的 127.0.0.1 当作宿主。可使用有明确源地址限制的 Docker 桥接代理；实施前核对实际网络地址。
5. 新增 IDMS 独立虚拟主机；先 `nginx -t` 再平滑 reload，保留现有 NPM/Harbor/其他站点。仅将 `/identity/realms/` 和 `/identity/resources/` 转发到身份服务，阻止公网管理接口。
6. 维护窗口中将 Keycloak 改为 `KC_HOSTNAME=https://idms.xin/identity`、`KC_HTTP_RELATIVE_PATH=/identity`，只接受受信反向代理覆写的 forwarded headers。同步网站 `IDMS_PUBLIC_ORIGIN=https://idms.xin`、`IDMS_OIDC_ISSUER=https://idms.xin/identity/realms/idms` 和 Keycloak client 的严格回调/退出地址。
7. 由所有者完成真实账户开通、首次密码设置及必要 MFA；企业管理员与业务终审账号分离。不要在聊天或 GitHub 中提交临时密码。
8. 用真实浏览器完成 HTTPS、登录/退出、Secure/HttpOnly 会话 Cookie、上传/独立审批、跨租户拒绝和备份恢复验收。复核服务器资源及已有站点，记录真实结果后再开放使用。

上述公开接入完成仍不代表完整商业验收。原 `NODE_ENV=production` 门禁要求的容量、高可用、完整备份恢复等事项需继续完成。

# 维修控制台开发状态

后台持久队列、真实 OIDC/加密共享会话、独立 HTTP 与 worker 命令行、真实 Flowable 调度及范围读取已接通。独立 PostgreSQL 13项、真实 Flowable 8项、真实身份/命令行6项检查通过，另有5种错误配置拒绝。

详情及当前验证范围见 [后台接线进度](maintenance-console-backend-v4-progress.md)。初稿 flow_defer_v4 的 FOUND 问题已修复并实际验证。

工单界面、浏览器 PKCE 登录、断网重载与身份切换交互、三宽度及整站切换尚未完成。本分支未合并 main，未部署到云端。部署文档、部署提交及校验清单只描述 main，不覆盖本分支新增的控制台开发。完整商业验收继续。

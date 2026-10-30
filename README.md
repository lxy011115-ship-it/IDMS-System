# IDMS 企业设备与运维管理

当前为本地开发版和企业试点准备版，软件版本由 package.json 的 0.1.0 统一提供。正式生产门禁仍开启。

## 当前功能

六大入口为工作台、设备中心、备件与采购、运维中心、数据与报表、系统管理。现有功能包含设备资料、七类数据上传及独立终审、维修工单、供应商及采购审批、分批收货、领退料与调拨、盘点、更换登记和操作历史。票款仅登记，供应商下单由人员执行。

备件列表、历史、远程搜索选项及工单用量使用数据库分页；完整审计、备份和隔离恢复的本地证据见[当前交付索引](docs/current-delivery-index.md)。工程规则未经现场标定，不作为生产预测或降本承诺。

## 使用与开发

- 已配置的本机平台：运行根目录“启动IDMS本地网站.cmd”，打开 http://127.0.0.1:4010/ ，从企业登录入口使用已有账号。
- 普通启动和账号初始化分离。账号、数据库、密钥及原生依赖的首次配置另见[认证说明](docs/authentication-guide.md)及[本地启动说明](docs/local-startup-and-package-guide.md)。不要通过重复初始化恢复旧权限。
- [备件采购操作指南](docs/spares-procurement-guide.md)、[岗位权限与操作历史](docs/spares-history-and-permissions-guide.md)、[上传审批指南](docs/upload-approval-experience-guide.md)。
- [备件分页接口](docs/spares-paged-query-guide.md)、[同连接事务与取消](docs/spares-transactions-and-cancellation-guide.md)、[审计证明](docs/spares-audit-proof-guide.md)、[归档恢复](docs/spares-archive-recovery-guide.md)。

开发检查使用 Node.js 24.20.0 和锁文件：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
node --test tests/package-guard.test.mjs tests/package-verify.test.mjs
```

上述检查不会配置企业数据库、启动完整平台或完成生产验收。文件演示也不能替代 PostgreSQL/OIDC 备件平台。

## 发布边界

本仓库管理公开源码，不包含本机账号、企业数据、密钥、数据库档案、运行依赖和本地交付截图。发布清单和敏感内容检查范围见[源码发布说明](docs/source-release-guide.md)。真实多岗位验收、同版 Linux/服务器验证和完整培训媒体继续推进。

idms.xin 尚未确认完成备案；本轮不启用公网服务。根 Compose 及 deploy/ 内的 2026-10-20 记录是历史部署资料，不能当作当前安装或上线成功证明。生产拓扑、TLS、受管密钥、告警、跨服务恢复及支持责任见[生产准备状态](docs/production-readiness.md)。

[企业交付、路演和竞品评估](docs/prelaunch-enterprise-roadshow-review-2026-10-29.md)说明优化依据；[历史研发记录](docs/history/development-notes-through-2026-10-29.md)保留原文供追溯。

# IDMS 设备管理与预测维护系统

设备、数据导入、质量、预警、维修工单、模板及审计的开发项目。

当前完整网站使用 v2 入口；v4 增量存储、治理、认证审计及维修内核已归档，仍在分阶段接线。完整商业验收未完成，生产发布门禁保留。

## 开发校验

需要 Node.js 24.20.0：

```sh
npm ci --ignore-scripts
npm run build
npm test
```

真实 OIDC 和 PostgreSQL 需要独立部署配置。禁止用演示身份在公网运行。

## 服务器部署

目标域名：idms.xin。网站、PostgreSQL 和 OIDC 已部署到服务器回环地址并通过内部检查。公网开放等待 ICP 备案。见 [部署说明](deploy/README.md)。

仓库包含已发布源码与技术文档，不包含运行数据库、客户文件、密钥、登录账户、历史工作目录或未验证的工单控制台代码。源码导出摘要见 [source-export.json](deploy/source-export.json)。

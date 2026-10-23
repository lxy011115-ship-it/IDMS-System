# PostgreSQL 生命周期模块使用说明

该模块供整套平台管理器调用，负责显式创建一个 PostgreSQL 16 进程、核对实际 SQL 身份和执行正常关闭。当前尚未接入整套管理器，也未替换原运行数据库。原运行数据库的 PID 不能作为本模块的句柄使用。

## 准备条件

- Node.js 24.20、已安装的项目依赖、受支持的 PostgreSQL 16 工具目录。
- Linux 非 root 进程；Windows 非管理员控制器。管理员直接运行会被 PostgreSQL 拒绝。
- 数据目录已正常关闭，具有严格离线配置，且已知 system identifier；不能包含活动 PID 文件、外部表空间或 WAL 链接、恢复信号、硬链接别名或执行钩子。
- 数据目录和私密记录目录互不包含，端口仅使用回环地址。
- 从私密配置边界取得账户；密码须为 32–4096 字符且不含换行或 NUL，数据库固定为 `postgres`。不要把账户、日志或记录目录提交到 Git。

## 调用顺序

```js
import {
  launchPostgresLifecycleV1,
  bindPostgresLifecycleV1,
  inspectPostgresLifecycleV1,
  stopPostgresLifecycleV1,
} from './scripts/postgres-lifecycle-v1.mjs';

// options 由控制器从受保护配置构造，字段必须完全匹配。
const handle = await launchPostgresLifecycleV1(options);
await bindPostgresLifecycleV1(handle);
const status = await inspectPostgresLifecycleV1(handle);
// 上层管理器先停止接收业务并排空所有客户端与 prepared transactions。
const proof = await stopPostgresLifecycleV1(handle);
```

`options` 只接受 `binDirectory`、`dataDirectory`、`workDirectory`、`expectedSystemIdentifier`、`port`、`account`。`account` 只接受 `user`、`password`、`database`。启动返回实际句柄及 `terminal` promise；绑定成功才可向上层报告数据库就绪。克隆对象、PID 对象和上次启动的句柄不能接管新进程。

停止前会再次核对配置、目录、工具、PID 文件与 SQL 身份。有其他客户端或 prepared transactions 时拒绝停止，不发送关闭请求；修正条件后可重试。已接受的请求复用原 promise；如显式提供 `requestId`，必须保持相同 UUID。模块只执行 `pg_ctl stop -m smart`，完成证明包含实际自有进程退出和同一集群的干净离线状态。

启动或绑定失败时仍须保留实际句柄和私密记录，调查实际进程状态。观察超时不能证明进程已退出；不要删除 PID 文件或用未知 PID 强制关闭来补造成功。已接受的停止若结果不确定，不重复发送请求。

## 验证入口

Windows 管理员开发环境可使用固定 QA 适配器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-postgres-lifecycle-windows-v2.ps1
```

该脚本创建受限 token，只启动固定 Node 和固定验证入口，不接收任意程序、账户或 PID。它不是生产启动器。仅在需要验证新改动时运行，不为刷新状态重复执行已有成功案例。

Linux CI 在全新 checkout 中执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/prepare-postgres-lifecycle-baseline-v1.mjs
IDMS_QA_POSTGRES_BIN=/usr/lib/postgresql/16/bin node scripts/verify-postgres-lifecycle-v1.mjs
node scripts/verify-postgres-lifecycle-cleanup-v1.mjs <本次实际nonce>
```

baseline 是父提交 `bc0d65da9182ca1caa8ea0a91a4b211d104e1fce` 的 596 个既有文件摘要，表示这些输入保持，并非当前 HEAD 的整体验收。准备脚本独占写验证兼容元数据，不能在已有发布记录的目录运行。原生验证只创建新的隔离集群和合成数据，不连接原数据库或原端口。

## 结果边界

Windows 已有一次实际 13 项成功与独立清理证据，详见进度文档。Linux 原生、平台接线、旧 owner 可信移交、整套故障恢复、生产容量和最终用户操作验收仍须分别提供证据。当前云端源码准备不等于此模块或整套新应用已上线。

# 平台现场依赖控制器（开发验证版本）

本阶段把数据库、身份认证、工作流、预测服务、MQTT broker、网站应用和边缘采集接到一个实际进程生命周期控制器。当前代码为本地开发候选；完整原生验证与 Linux 验证结果以本阶段进度记录为准，本文不授予生产启用权限。

## 配置与启动

入口为 `createPlatformDependenciesV7(config)`，配置必须为 `format: 3`、`purpose: PLATFORM_DEPENDENCIES_V3`。它返回本次创建的控制器，提供 `ready`、`status()`、`resources()`、`close({requestId})`、`closed`。应保留返回的原始控制器对象，用它发起关闭和重试。

不启用现场接入时，`field` 只能填写 `{enabled:false}`。启用时需完整声明 `brokers` 和 `edges`，并与应用清单中的唯一现场 SITE 保持一致。配置检查覆盖企业、通道、端口、数据库目录边界、broker ACL、实际证书和密钥材料、工作流数据库端点、预测客户端令牌。不要把私密配置、私钥或原生验证目录提交到 GitHub。

实际启动顺序为 PostgreSQL → 身份认证及工作流 → 预测服务 → broker → 应用组（含 SITE）→ edge。`ready` 成功仅表明声明的服务就绪，状态中的 `formalFieldActivationGranted` 仍为 `false`。独立人工审批、历史数据及签名键迁移、全系统验收仍须完成。

## 正常停止与阻塞重试

调用 `close({requestId})` 时使用一个 UUID。重复调用保留相同请求，不能更换请求 ID。控制器按 edge → 应用组 → broker → 预测及工作流、身份认证 → PostgreSQL 关闭，并核验原始进程句柄、实际输出流关闭、SQL/HTTP/MQTT 资源退役等证据。

结果为 `BLOCKED` 时读取 `blocked` 定位未满足的条件，处理该条件后，在同一控制器上用同一请求再次调用 `close`。例如独立 SQL 客户端仍连接数据库时，应先由该客户端正常断开；控制器不会绕过数据库停止门禁。观察超时不能作为进程已退出的依据，也不能据此采用历史 PID 或新建替代控制器接管。

启动中取消同样使用 `close`，或在创建时提供 `startupSignal`。已经创建的 edge 必须先退役，SITE 才能关闭。取消结果不宣称平台曾完整就绪。

## 验证场景与证据

`scripts/verify-platform-field-dependencies-v3.mjs` 在独立目录创建真实数据库、Keycloak、Flowable、预测服务、mTLS MQTT broker、九成员应用组和 OPC UA 只读采集。除保留前一版本的两个历史数据锚外，新增场景核对两个租户登录、积压事件重放、SQL 写入阻塞下的排空、数据库连接阻塞后的同请求重试、启动中取消和无关 broker 隔离。

`scripts/verify-platform-field-cleanup-v4.mjs` 通过实际子进程结果、应用注册日志、签名 ACK、SQLite 状态 MAC、当前状态树成员及不存在证明、数据库离线控制信息独立复核结果。ACK 存储是容量有限的环，检查会合并保留与归档的已验证签名，证明每个已提交点都有对应回执。

Windows 第三轮原生验证启动前固定了 1,229 个源码文件。受限启动器禁用管理员及 PowerUsers 组，保留当前用户创建自身进程和管道所需的默认访问规则；独立小型 PostgreSQL 启停验证已通过，整组平台验证仍须另行通过。后续新增的本说明与 Linux 工作流属于发布支持文件，未冒充该次原生冻结输入。Linux 工作流为 `.github/workflows/platform-field-dependencies-v1.yml`；提交并取得实际成功记录之前，不得声称 Linux 版本通过。

最终面向使用者的中文图文说明与实际旁白、字幕演示视频，仍需在完整系统和交付版本验收后制作；本说明是开发运维接线说明。

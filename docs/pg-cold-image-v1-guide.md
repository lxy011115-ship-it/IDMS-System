# PostgreSQL 16 冷镜像基础层

本层为 IDMS 新 schema 的正式恢复准备提供完整 PGDATA 加密封装。它保留 OID、角色、序列和文件内密文；原有旧工作流逻辑备份的 38 表范围不变。当前交付是离线文件原语和独立集群验证，尚未接入 R4 的持久停写、外部身份、工作流和恢复运行准入，不能用于直接切换正在运行的原系统。

## 接口与条件

`scripts/pg-cold-image-v1.mjs` 导出 `generateColdImageKeyV1`、`coldImageKeyBindingV1`、`captureColdImageV1`、`authenticateColdImageV1`、`restoreColdImageV1`。调用者显式提供真实 PGDATA、规范化工具目录、预期 system identifier、独立密钥文件、私密工作/输出目录；恢复另需预期 backup ID 和全新目标目录。接口不停止数据库、不启动恢复后的服务、不解除角色或业务围栏。

工具目录需先取得实际规范路径。Windows Codex 的 AppData 虚拟化可能令表面目录与 `realpath()` 不同；不要放宽私密 I/O 的目录校验。使用同平台、同架构、PostgreSQL 16，核对 postgres、pg_ctl、pg_controldata 三个程序的版本和摘要。动态库、扩展、外部服务及配置代际见证仍由后续准入处理；三程序一致不能代表全部运行环境已验证。

源必须正常关闭、无 postmaster.pid，pg_ctl status 为 3，pg_controldata 为 `shut down` 且 system identifier 与调用者给定值一致。库不接受在线或崩溃态镜像。目录树不能有链接、多硬链接文件、特殊文件、外置 tablespace、WAL 链接或 standby/recovery 信号。树中全部目录、普通文件、长度和 SHA 纳入认证，捕获后再核目录身份、完整内容树、控制文件和程序摘要。

当前配置采用严格白名单：仅允许有限的容量、日志时区、语言、文本搜索、回环监听、端口及耐久性设置；HBA 仅允许回环/本地 SCRAM，ident 不得有活动规则。不支持 include、外置配置/数据路径、命令钩子、预加载库或 SSL 私钥配置。未知设置应拒绝，需扩展配置档并验证后再支持，不能临时关闭校验。

## 文件与失败行为

镜像使用独立随机 256 位密钥和 AES-GCM。格式、key ID、nonce 头作为 AAD；规范 manifest、所有文件内容及标签形成整体认证。大文件按块处理，不将整个集群读入内存。32 GiB 总量、2 GiB 单文件、50,000 文件等数值仅是当前拒绝上限，未做相应容量验收。

捕获经自验后以硬链接排他发布 `.idmspgcold` 文件；已有同名结果直接拒绝，不覆盖。恢复先完成 AEAD、manifest、逐文件摘要与配置验证，再创建全新私密目录。恢复目标必须位于源目录之外，不能覆盖已有目录；成功返回仍是离线状态，`automaticActivationApproved=false`。

正常失败清理仅删除身份清单匹配的自有临时条目。恢复目标若出现未知文件或身份变化，拒绝清理并保留隔离现场。进程崩溃的持久重入、硬链接发布间断点收尾、源旧进程退休与目标激活由后续控制器实现；本层没有自动重入或正式切换承诺。调用者不得直接递归删除未识别目录。

镜像、密钥、初始化口令、私密 SQL 证据和 PGDATA 只能放私密工作目录，不提交 Git。公开验证只含去秘密摘要。密钥/运行配置的独立恢复、轮换和外部身份服务不默认包含在 PGDATA 中。

## 验证入口

- `node --test scripts/pg-cold-image-v1.test.mjs`：路径/配置、认证与摘要、覆盖拒绝、中断清理和未知条目隔离。
- `node scripts/verify-pg-cold-image-v1.mjs`：在 `work/pg-cold-image-v1-20261022/<nonce>` 创建独立 PG16 集群、两个数据库和跨 schema 样本；验证正常关闭、整簇冷备、OID/角色/权限/触发器/非 MVCC 序列及 OID AAD 密文恢复，最后正常停止自有进程。
- `node scripts/verify-pg-cold-image-cleanup-v1.mjs <nonce> ...`：只读核对各生成目录、集群标识、clean shutdown 与原 postmaster PID 已不存在；不删除或终止任何对象。

这些样本不冒充 R4 实际表/完整工作流。后续仍需把真实 CANCELLED、BLOCKED/HELD、未知授权关闭围栏、RELEASE_STARTED、会话和租约过期纳入恢复演练，并证明原源保持围栏且不会重复发布工单。冷镜像也不能代替 PITR、HA、跨平台迁移或逐租户逻辑恢复。

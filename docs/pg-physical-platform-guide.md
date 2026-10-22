# PostgreSQL 跨平台物理恢复检查

`scripts/verify-pg-physical-platform-v1.mjs <PostgreSQL16-bin目录>` 使用全新自有集群，不接入现有 PGDATA、数据库或身份服务。新 factory 接受明确工具目录，解析真实路径，在 Linux 拒绝 root 身份；原 Windows factory、备份格式、SQL 围栏和已有准入实现保持原版。

脚本在两个独立数据库中创建合成的中文、JSON、二进制数据、序列和大对象，安装并封存既有 SQL 写入门。实际 APP 连接验证读取成功、CLOSED 拒写；随后结束所有自有连接，设置 APP NOLOGIN/连接限额 0 和数据库连接限额 0，正常关闭 PostgreSQL。

使用真实二进制 SHA 固定的工具链捕获完整加密 PGDATA。错误密钥和篡改镜像必须在创建目标前拒绝；已有目标必须保留原文件并拒绝覆盖。认证恢复到新目录后实际启动 PostgreSQL，核原 system ID、数据库与角色 OID、冻结连接属性、ACL、结构摘要、数据、序列、大对象、原门目录哈希和 DDL epoch。源保持关闭，APP 登录仍拒绝。

冻结期间运行角色有意为 NOLOGIN，不能将只接受正常 LOGIN 配置的运行时目录检查器当作冻结状态检查器。恢复检查使用原结构摘要、冻结全局清单和原封存状态；不把冻结权限重定为新基线，也不自动开放 SQL 门。

测试完成后核真实 system ID、数据库 OID/owner、角色 OID 和零其他连接，再删除活动目标测试资源并正常关闭自有 PG。冻结源、加密镜像和私密证据离线保留；失败发生在源关闭后时也保留源，不为清理而重启。测试报告区分镜像是否已产生，不能宣称所有副本已经删除。

`.github/workflows/postgres-physical-verification.yml` 在 Ubuntu 24.04 托管 runner 上执行该脚本，明确使用 `/usr/lib/postgresql/16/bin`，不启动 runner 的系统 PostgreSQL 服务，不使用阿里云或企业数据。工作流使用只读仓库权限、固定 Node 版本和官方 Action SHA；不上传密钥、PGDATA 或测试镜像。运行的实际工具版本与结果写入日志和 job 摘要；失败保留并继续修正，不能用构建通过替代实机检查。

此检查证明整簇物理工具与冻结状态在对应平台的行为；它没有启动 Keycloak、Flowable、整站或当前身份权威，没有执行恢复后业务准入或生产切换。完整受控恢复、跨服务一致性、真实浏览器及阿里云容量仍需各自验收。Windows 与 Linux 的物理镜像不互换。

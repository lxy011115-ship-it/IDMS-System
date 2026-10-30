# 现场恢复控制工具进度

已实现 Windows 恢复控制文件的初始化、恢复开始、同一操作重试及只读状态查询。485 项单元测试、205 项运行构件及类型检查通过；真实 PostgreSQL、实际 CLI 和 8 种崩溃场景通过。此项属于现场通道第 6 项的阶段进展，完整方案 A 继续开发。

## 当前行为

初始化先核对企业库、基础迁移、现场模块和完整根；确认没有已有初始化、正式注册或现场数据。唯一保护审计真正提交后才原子发布 ACTIVE，最后持久化结果并退役待完成标记。提交响应丢失或结果未返回时，resume 使用原操作 UUID，从真实数据库核对原审计；不会重复初始化或增加根修订。

恢复开始需要当前控制内容摘要。工具先持久化操作意图和固定标记，再发布新激活身份的 RESTORING，然后记录源库保护审计，等待完整的至少 2000ms 单调静默期。重试也重新等待完整静默期。工具始终保留 RESTORING 和待完成标记；目前没有恢复激活入口。

运行时读取控制文件前后均检查待完成标记。即使文件仍是旧 ACTIVE，或初始化已发布 ACTIVE 但结果尚未完成，标记也会关闭接入。错误摘要、错宿主、外来日志文件或损坏的最终结果均拒绝，不静默修复未知材料。

## 所有权与文件发布

部署 authority 使用独立特权连接取得源集群的企业级会话锁；业务审计另用企业最小权限账号。此 authority 不是最小业务角色。操作还绑定当前宿主、集群摘要和控制路径，并持本机 IPC 锁。不同宿主或集群不得自动接管；部署私密目录和共享控制文件属于信任边界。

受控阶段文件先 flush，再通过固定原生助手执行同目录 MoveFileExW/WRITE_THROUGH 发布。助手不接收数据库密码，检查逻辑所有者 PID 和真实创建时刻，并持独占提交管道。新执行者还须核对已记录助手的宿主及进程身份，等待助手真正退出。观察超时和逻辑父进程退出均不构成文件助手已停止的证明。

当前写入后端只在 Windows 实现并验证；其他平台在取得锁或写文件前明确拒绝。Linux 写后端和跨宿主灾备移交仍待实现。未执行物理断电测试。

## 命令

在项目根目录运行，私密配置文件由部署者准备，勿放进交付目录：

```powershell
node scripts/field-recovery.mjs --action status --tenant acme --control-file <控制文件绝对路径>
node scripts/field-recovery.mjs --action initialize --authority-config <部署配置> --runtime-config <业务配置> --tenant acme --control-file <控制文件绝对路径>
node scripts/field-recovery.mjs --action begin --authority-config <部署配置> --runtime-config <业务配置> --tenant acme --control-file <控制文件绝对路径> --expected-control-digest <status返回的摘要>
node scripts/field-recovery.mjs --action resume --authority-config <部署配置> --runtime-config <源业务配置> --tenant acme --control-file <同一控制文件> --operation-id <原操作UUID>
```

begin 可另传 `--target-runtime-config` 绑定计划目标，但这不表示目标已经恢复或验证。status 不读取 authority 配置、不连接数据库，仅报告文件和标记状态；不能据此判断执行进程已停止或数据库已经验证。失败保留原操作材料，应检查后使用原 UUID 恢复，不能手工删除标记或回滚 ACTIVE。

## 验证与后续

隔离实际 CLI 验证初始化、完成后重试、错误摘要、损坏结果、错宿主、外来文件、只读状态及恢复静默期。8 种进程故障覆盖真正 COMMIT 前后、提交响应丢失、初始化/恢复原生移动前后，以及最终标记已退役但结果尚未返回。测试监督器独立保留真实原生助手，确认逻辑所有者退出后助手仍活着；新执行者确实等待助手终态，才按原操作继续。恢复场景最终均为 RESTORING。

真实 OIDC/浏览器/OPC UA/SQLite/mTLS/最小角色 PG 联合回归通过，Write/Call 为 0。该联合回归通过自有 fixture 注入控制状态；原子写入工具由另一组真实 CLI/故障测试验证。两者均未执行完整数据库恢复，不能合并表述为恢复全链已经通过。

原 4010 核心、启动器及独立 PG/Keycloak 身份和健康保持；本轮没有部署、重启原核心或对原企业库执行现场 DDL。66 份完整文件契约和十轮双份共每份 1571 文件的冻结 SHA 保持。没有生成第 11 份最终快照，也未交付真实配置、密钥、SQLite 或原始日志。

后续继续 public + idms_field 独立加密完整归档、新最小角色隔离恢复、源业务停写、关闭 FIELD 的维护实例和恢复计划独立终审。备份中的旧批准不能自动成为恢复后的当前许可。之后再完成证据冻结、离线 CLI、完整全链及第 7 项受控部署。

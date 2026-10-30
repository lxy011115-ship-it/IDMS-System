# PostgreSQL 正式生命周期入口

接续已批准的整套服务管理计划。应用组已经有正式入口，数据库仍由物理恢复验证夹具使用 pg_ctl 启动。本阶段补足真实数据库进程的创建、绑定和正常关闭接口，供后续整套管理器调用；不将此组件完成称为整站部署、旧 owner 移交或商业验收完成。

采用控制器直接 spawn 已固定版本的 PostgreSQL 16，并保存真实 ChildProcess。沿用现有严格离线配置、工具摘要及 clean shutdown 检查。拒绝已有 postmaster.pid、运行中的目录、链接、危险配置、错误 system identifier、外部 PID 和任意启动程序。数据库与控制器记录目录必须分离。只绑定回环端口。

权限前提：Linux 拒绝 root；Windows 控制器必须处于非管理员身份。PostgreSQL 自身拒绝管理员 token，模块没有自动降权能力。本阶段 Windows QA 包装器使用受限 token 创建固定验证程序并等待实际进程句柄，只作为隔离验证入口，不能作为任意脚本启动器或生产权限配置替代。

launch 返回本次真实句柄和 terminal promise，bind 独立等待数据库就绪，避免启动失败时调用者丢失实际资源句柄。绑定同时核 postmaster.pid 的 PID、目录、启动时间和端口、真实 SQL system identifier/数据目录/端口，以及本次 ChildProcess 仍存活。日志和凭据只留在私密边界内，标准输出不含密码或原始异常。

stop 先校验目录、工具、配置和原绑定，要求其他 client backend 与 prepared transaction 均已排空，再持久写入本次 stop intent。只调用固定 pg_ctl 的 smart stop；禁止 fast、immediate、通用 kill 和对未知 PID 发信号。完成需真实自有进程零码退出、原目录无 PID 文件、pg_controldata 确认同 system identifier 且 clean shut down，以及未改变的工具与配置。重复已接受的停止请求等待原操作，不重复发送。停止前检查失败可以修复条件后重试；已经发送停止后的不确定结果保留原请求。

绑定失败不自动强制关闭。调用者保留实际句柄及私密记录，后续控制器必须显式处理未完成启动；不凭观察超时断言资源已退役。启动器不导入验证夹具、不创建 QA 数据库、不隐式读取本机原生产账户。

验证包括实际隔离 PG16 的正常启动、数据保留、smart stop 与正常退出；活目录/错误身份/危险配置/伪造句柄/活客户端/配置漂移拒绝；重复停止不重复执行。原运行 PG、原数据、现有源码、云端 bc0 候选和工作流 JAR 保持。此阶段完成后继续身份/工作流及其它依赖登记、完整故障与恢复和最终图文视频材料。

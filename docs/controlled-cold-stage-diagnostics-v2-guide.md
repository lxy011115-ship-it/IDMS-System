# 冷恢复阶段诊断

新增入口 `scripts/verify-runtime-application-suite-v22.mjs` 与独立检查 `scripts/verify-runtime-application-suite-cleanup-v23.mjs`，通过独立工作流 `controlled-cold-diagnostic-verification.yml` 验证。原有六条受源策略约束的 CI 文件和已执行验证入口保持原样。

## 输出内容

启动数据库、构建工作流、启动身份服务、建立站点工厂、封存目录，以及恢复后的旧凭据拒绝、配置生成、旧 CLI 拒绝、工作流重新连接、预测服务启动、运行配置加载、HTTP 启动、过期身份拒绝和重新授权均有固定阶段名。每阶段输出开始、成功或失败，等待时每 10 秒输出运行时长及资源类型计数。

错误只输出允许的错误类别和代码、摘要、字节数、子进程退出码及信号。PostgreSQL 错误须同时符合 SQLSTATE 格式、已知类别和 PostgreSQL severity，才输出 SQLSTATE；直接 cause 同样处理。错误正文、SQL、参数、密码、令牌、schema/table 名称、stdout/stderr 和完整命令不会进入诊断输出。原异常对象继续向上传递。

阶段观察器不发送停止信号、不接管或重启进程，也不把等待时间当成失败。主入口仍以实际句柄完成原清理流程，随后由独立检查验证退出及封存输入。

## 资源登记修正

恢复后的本地站点运行对象加载成功后立即登记，再加载 worker。这样 worker 加载失败时，清理仍持有已经创建的本地对象；此前连续加载两个对象后才统一登记，存在第一个对象失去清理引用的路径。

## 验证边界

5 项诊断单位检查已通过，覆盖真实子进程失败、原异常保留、脱敏、等待心跳及 SQLSTATE 分类。完整 Windows 恢复验证已启动，结果以其实际退出和独立检查为准。Linux 新诊断尚待执行。

原核心和后台 Linux 作业在 `database-migrations.mjs:127` 报错，具体 SQLSTATE 未取得。该位置处于 ROLLBACK/重抛语句，仅凭位置不能确定原始原因。本次没有猜改生产迁移逻辑，也没有将诊断测试通过等同于原恢复失败已修复。

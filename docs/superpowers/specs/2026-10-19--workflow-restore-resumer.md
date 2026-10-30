# 工作流隔离恢复的持久状态机

延续已授权完整方案A及正式归档v2规划。新版本恢复协调器使用受限控制库ledger和session advisory lock，完整认证归档/manifest/dumpSHA后才操作目标。旧归档/恢复内核及其16源审阅快照不变。恢复不连接源库、不释放源围栏、不批准业务激活。

选定方案是新控制器按持久操作ID重入，目标始终隔离；不在进程内靠内存猜测前次CREATE/restore结果，也不把普通异常清理当崩溃恢复。仅目标名idms_workflowrestore_<tenant>_<12hex>和同名最小NOLOGIN角色，目标DB connection limit 0；pg_restore以管理连接登录、SET ROLE到该owner，业务凭据始终不可登录。独立私密凭据文件不覆盖，ledger只保存其摘要与角色属性/密码验证器摘要。

角色创建与ROLE_CREATED ledger同控制库事务提交。CREATE DATABASE不能在事务内执行，先记DB_CREATING，再按精确新角色OID、唯一所有权、编码/locale、连接上限和允许的初始ACL核对未知提交结果，再保存DB OID。该窄创建窗口内仍信任超级管理员没有冒用私密新角色创建相同目标；已记录OID后同名替换一律拒绝。其余角色/ACL/目录/请求漂移拒绝，不自动修复。

阶段为INTENT、ROLE_CREATED、DB_CREATING、DB_READY、RESTORING、RESTORED、RESETTING、VERIFIED。未完成的自有目标在确认进程/准确PG后台全部退休、catalog/权限/原OID保持后，按RESETTING持久意图删除重建；不是对未知或已VERIFIED目标的覆盖。VERIFIED重放只读复核38表/2seq/上下文后复用，不再次恢复。NOLOGIN/connlimit0保持到显式后续激活流程。

每轮先登记实际OS owner/host、runID、唯一PGAPPNAME、原生程序SHA、固定参数与私密认证dump路径，再启动pg_restore。旧owner仍活或host不同拒绝接管；原生退出与SQL后台退出分开确认。完整single-transaction恢复结束并确认后台消失后，用只读RR复核原38表/两非MVCC序列/编码locale和session参数，才提交VERIFIED。

认证明文沿用已登记workspace，恢复重试先精确退休原生程序再清理旧明文，避免删除仍被旧原生读取的数据。真实QA覆盖角色事务提交前后、CREATE DB结果未知、native启动/实际COPY、验证提交前后、目标OID/ACL漂移、错误key/tenant/档案无目标副作用与自有资源清理；准确声明实际覆盖，缺失不冒称通过。原workflow9124、core5356和edge17428不停止/冻结/升级。

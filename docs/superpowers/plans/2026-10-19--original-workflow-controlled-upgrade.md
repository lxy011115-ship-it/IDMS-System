# 原工作流升级执行步骤

1. 准备旧两租户基线、jar/config/token pin与新私密reader配置；真实原business outbox门无DML探测（已完成prepare.mjs，不重跑）。
2. 建立精确进程/端口/依赖验证、独立worker和受控协调器；语法及原preflight核对后进入切换。
3. 持有两outbox维护锁、确认无PENDING/live lease，准确退休旧Java、两原source prepare/freeze。
4. guarded正式档案、持久隔离恢复，两测试目标实际Java启动/快照/凭据边界，目标重新隔离复核。
5. 释放原source fence、启动新本机4016 Java，原facts/context/reader快照/旧client/其他运行与角色后验，再释放outbox门。
6. 新拓扑重复核验、原业务资料和积压守恒、双份精选源码/证据及项目记忆，保留源备份和独立key，不标整体验收。

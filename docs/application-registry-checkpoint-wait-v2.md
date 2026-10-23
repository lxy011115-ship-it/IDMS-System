# 并发登记库检查点等待修订

`bbe3a8f` 的旧核心 CI（run `40009217672`，job `120604947850`）在 36 项单元中通过35项，独立检查点写入子进程遇到 SQLite `261`、`database is locked`，测试约356毫秒即失败。该记录保留，不通过重跑覆盖。

SQLite 将261定义为 `SQLITE_BUSY_RECOVERY`。Node24.20.0的 `DatabaseSync.timeout` 可设置忙等待，默认值为0；原测试的额外检查点连接未设置它。原代码还使用 `exec()` 丢弃 `wal_checkpoint` 的状态行，即使被阻止也可能计入“完成”。参见 [SQLite错误码](https://www.sqlite.org/rescode.html#busy_recovery)、[Node24.20.0 SQLite选项](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#new-databasesyncpath-options) 和 [检查点状态行](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)。

修订只增加新的测试辅助程序与回归文件；`runtime-application-registry-v1.mjs`、原V1测试及写入程序保持原样：

- V2检查点连接设置并读取确认 `timeout:3000`，逐次检查实际返回 `busy:0, log:0, checkpointed:0` 后才计数。完整33事件、并发快照读、文件变化、硬链接和篡改链拒绝均保留。
- 新读锁案例在父进程持有实际SQLite读事务时，由子进程追加一次事件并观察 `TRUNCATE` 的真实忙状态；父进程继续持锁，确认等待操作尚未完成，再释放该读事务，检查点随后成功且序号仍为1，没有重放业务事件。

Windows上的两项测试已实际通过（tool `ed3a0e`，exit0）。这证明本机修订场景，不代表Linux失败已修复或该提交全部CI已成功。当前其他CI继续观察同一作业；后续接入和发布仍需保留原失败，并取得新提交的实际Linux结果。

六组件V6的Windows41项与独立清理已在`bbe3a8f`发布之前实际通过；其中的985源输入保持。本次测试辅助程序修订不改规则预测、PG/JVM或应用生产模块，不把单元检查替代六组件组合证明。

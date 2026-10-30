# 规则预测服务的实际生命周期

规则预测服务现在有固定创建与关闭适配层。`scripts/predictor-lifecycle-v1.mjs` 只接受运行配置文件和私密记录目录，不接受 PID、任意入口、程序或环境覆盖。复用原 `createPredictorServiceV4`、规则模型和 HTTP 鉴权，不改变规则结果，不增加真实 RUL 或模型验证结论。

先调用 `launchPredictorLifecycleV1({runtimeFile,workDirectory})` 保存实际 fork 句柄。子进程核对运行配置、固定导入闭包与 Node 程序，完成 CREATED 握手后，由 `bindPredictorLifecycleV1(handle)` 发起 START 并等待实际监听就绪。尚未绑定时可以正常取消，避免先创建服务后丢失句柄。

`stopPredictorLifecycleV1(handle,{requestId})` 只接受本模块 WeakMap 留存的实际创建句柄。停止意图先固定到私密文件，再发送关联消息；READY、停止接受和关闭均绑定实际父子 PID、所有者、随机挑战摘要、配置与封套摘要。重复停止复用同一操作，改变请求编号被拒绝。配置漂移使预检失败时不会发送停止意图，恢复原字节后可使用原编号重试。

收到停止请求后先拒绝新 HTTP 工作，再等待既有响应结束和 `server.close` 回调。父端还要观察实际根进程退出、stdout/stderr 关闭和 IPC 断开，才生成正常停止证明。观察超时不等于进程已经退出；生命周期适配层不提供通用强制结束或 PID 接管。

Windows 实际完成3项单位和7项原生检查，独立清理检查通过。包括真实鉴权/规则预测、错误控制消息与伪造句柄、真实半包 HTTP 请求在停止接受后继续完成、配置漂移与原请求重试、监听前取消、被占端口失败且原 QA 监听者保留。五个实际创建的预测根进程均退役，其中四次正常停止、一次预期启动失败，802份执行输入与695份父版本受管文件保持。详见 [Windows 验证记录](validation/predictor-owned-lifecycle-windows-v1.json)。

本模块尚未接入完整平台控制器；其他启用依赖的所有权与正常关闭、原私有数据恢复和整套验证继续。Linux 结果以当前提交的实际 CI 记录为准；单服务检查不能替代完整系统交付。

# 身份独立存续前置验证进度

2026-10-22：新隔离身份实例的正常停止和同库重启验证通过；完整原目标继续，尚未实施身份库跨PG迁移或原站切换。

- 最终验证8项：真实JDK21编译、私有分发启动、真实realm/user/access/refresh、外层owner/deployment/manifest/PID-start负例、agent内部owner负例、回执冲突拒绝、正常停止和SQL归零/重复同操作、同库同origin重启UUID与refresh延续。
- 两个新JVM35120/38788都exit0/nullsignal，helper回复均确认，2份完整proof及controller-release回执，每份运行清单503文件。三个历史轮次的自有PG都clean shutdown，3个记录的身份JVM原实例均退休；每轮自有1DB/1role已精确DROP。
- 第一轮d297ffdd82e7遇到icacls长路径限制，尚未启动JVM，保留失败记录与部分分发；改用短私有路径。
- 第二轮edb8320502e2完成Quarkus关闭和exit0，但框架最终退出截断Attach回复，helper挂起。确认目标36412已不存在，再以精确PID/创建时刻/父QA/命令绑定单独停止自有helper35612，未给目标或原服务发停止信号。另有停止日志正则错误，严格证明未通过；保留失败。修正最终退出放行协议和实际日志匹配后第三轮954bea1897b3通过。不能把第二轮当作通过或无人工补偿。
- 源码8直接pins（含旧owned PG夹具）与最终实际版本一致；清理CLI另实际只读执行。未修改原Keycloak目录、原JAR、原身份库及原运行进程；没有新浏览器标签、DNS/TLS/代理/安全组变更。

工具见证只涵盖7个选定JDK程序/库与新class/agent，分发清单涵盖全部复制文件和新配置；未穷尽环境/provider/native供应链。环境清理KC/KCRAW/QUARKUS与常用JVM注入变量；这不是完整环境见证。fixture直授登录用于会话存续验证，不替代正式浏览器PKCE验收。

后续依次继续：整库逻辑迁移的真实身份状态基线和认证加密封装、源正常停机/零连接及持久围栏、目标PG新库恢复、同issuer迁移后的UUID/JWKS/session/refresh/撤权/登出/scope验证、镜像外当前权威代数与旧库退役围栏、生产持久控制器与原站切换准备。原系统商用待办/PITR/HA/旧workflow权限/C outbox/原R5等继续；最终同验收版本中文PDF/DOCX真实截图和讲解字幕MP4仍未制作。

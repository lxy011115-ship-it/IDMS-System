# 工作流正常停止控制

本层用于新启动、显式选择受管生命周期的Spring Boot工作流实例。原服务与原target JAR保持，未向既有运行注入agent。当前实测平台为Windows/JDK21/Spring Boot3.5.7；Linux服务管理及Keycloak生命周期适配另行验证。

## 使用顺序

1. `buildWorkflowLifecycleToolsV1(privateParent)` 隔离编译Java控制工具，见证3份Java源、7个选定JDK程序/动态库、4个class及agent JAR。返回本进程注册的工具handle，不接受任意伪造工具对象。这不是完整JDK环境/供应链见证。
2. `launchWorkflowLifecycleV1(...)` 使用已核JAR与私密配置副本启动新JVM，固定owner、部署摘要、配置/程序与目录身份，启用平台管理bean及graceful web shutdown。只对停机相关日志开启INFO，保留应用其余日志级别。
3. 应用实际ready后调用 `bindWorkflowLifecycleV1(handle)`，核PID的OS启动时刻、owner、部署、JAR与目录。平台管理bean不等于远程JMX连接；本层未启动JMX connector或增加HTTP管理路由。
4. `stopWorkflowLifecycleV1(handle)` 先保存原停止意图，再以JDK Attach核同一身份并加载小型agent。agent内部再次核身份、JAR及有效的graceful配置，排他写STARTED，调用平台MBean关闭上下文；上下文返回后写COMPLETED并落盘。agent本身不调用System.exit，不向目标发进程信号。
5. 只有目标真实exit0/无signal、退出事实持久记录、原STARTED/COMPLETED回执完整、web优雅关闭及全部已配置Hikari回调日志可证时，返回正常停止证明。测试还通过独立SQL确认JDBC连接归零。

工具适用于同一OS用户受控进程。owner不是公网上的认证密钥，操作权限仍依赖OS访问控制与私密部署目录。生产恢复控制器还需注册完整发布版本、维护权和证据链，不能把此handle当作跨进程接管授权。

重复stop复用同一停止promise和原证明，不重新加载agent。辅助工具回复未确认时只等原目标真实终态并核原回执，不强杀，也不因观察超时另启服务。本轮未专门故障注入辅助回复丢失；控制器崩溃后接管、停止失败补偿与所有启动中止时点仍待验证。

## 实际验证

```powershell
node scripts/verify-workflow-normal-stop-v1.mjs
node scripts/verify-workflow-normal-stop-cleanup-v1.mjs <已完成运行的nonce>
```

验证使用已准备的本地JDK/PG和既有隔离工作流构建；可传入已核构建的verification.json路径。它创建新私有PG/两租户Flowable数据库，验证错误owner/部署/JAR/启动时刻拒绝、agent内部身份拒绝、排他回执不覆盖、SQL锁阻塞HTTP请求时的正常等待、一次命令/锁定状态跨重启保持及重复stop幂等。

只读cleanup入口检查明确选定运行的PG clean shutdown、原JVM实例已退休、关闭回执、实际JDBC归零证据和最终数据库目录删除，不终止任何对象。历史失败运行保留私密证据，不能因后来通过修改其失败结论。

原服务JAR、启动器、数据库、云/DNS/TLS/安全组均未由本层改动。生产恢复控制器、旧进程迁移/受控升级、当前身份库独立存续及原完整目标继续；最终用户图文手册和视频不由本维护说明替代。

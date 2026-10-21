# 工作流服务正常停止与可验证回执

生产恢复需要确认旧工作流服务完成请求、关闭Flowable引擎与Hikari连接池并实际退出。Windows上对子进程发送普通signal不能证明这些回调完成。本层新增显式选择启用的本机生命周期控制，保留原服务、原JAR与已发布夹具不变。

当前项目为Spring Boot 3.5.7，原控制器已有PreDestroy关闭引擎/连接池。使用其平台MBean的SpringApplicationAdminMXBean.shutdown调用应用上下文close；通过JDK Attach加载只执行该操作的小型Java agent，直接访问目标JVM的平台MBeanServer，不开启远程JMX或HTTP管理入口。参考：[对应版本源码](https://github.com/spring-projects/spring-boot/blob/v3.5.7/spring-boot-project/spring-boot/src/main/java/org/springframework/boot/admin/SpringApplicationAdminMXBeanRegistrar.java)、[JDK21 Attach](https://docs.oracle.com/en/java/javase/21/docs/api/jdk.attach/com/sun/tools/attach/VirtualMachine.html)。

启动器只管理自己启动的新JVM：固定Java/工具与工作流JAR摘要、私密配置摘要、随机owner、部署摘要、PID和OS启动时刻绑定；显式启用动态agent及Spring平台管理bean、配置graceful web shutdown。Stop只接受内存中绑定的自有handle。启动后读取目标系统属性核身份；发送停止前再次核PID启动时刻、owner、部署和JAR，agent内部再核同一身份。错误身份不得执行关闭。

停止意图先持久保存，agent在私密部署目录排他写STARTED与COMPLETED回执并force落盘；COMPLETED只能在上下文close返回后写出。agent不调用System.exit，也不发进程信号。正常停止成立需要完整回执、该JVM真实exit0、引擎/连接池关闭日志以及独立SQL验证其连接归零。确认回复丢失时核原回执/原进程，重复stop复用原操作，不另发关闭；观察超时不是进程终态，也不强杀。

在新隔离PG/两租户Flowable上验证：身份负例、正常关闭全部池、旧控制/工单恢复、restart，以及一个真实SQL锁阻塞的HTTP请求在graceful停止时等待并完成，之后进程退出。回执路径/摘要/已有目标或工具漂移应拒绝，私密配置不进入公开日志。

本层不负责停止未知PID，不给原运行安装agent，不自动接管失联owner，不替代生产持久恢复控制器、跨进程维护权或身份库迁移。原目标保持进行中。

# 独立身份运行时与正常停止

原方案A的身份库整库迁移需要先证明自有Keycloak能正常停止；当前原实例仍与业务PG共簇。本层只启动全新私有副本，不接管原PID，不改变原数据库。授权来自持续开发和部署准备要求；属于既定方案内部实现，继续自主验证。

方案比较：Windows进程信号不能证明Quarkus关闭完成；Spring MBean不适用；选择JDK21 Attach到显式受管新JVM，使用实际加载的Quarkus 3.40.1 blockingExit并观察关闭完成、进程退出和SQL连接。它是版本绑定的本地适配，不是Keycloak公开管理API。

分发复制lib/bin/providers/themes/version等，排除原data和conf；生成全新配置、私有data/logs、loopback端口、独立PG及账户，本地cache避免加入原集群。复制逐文件验证哈希，运行时清单含全部复制文件与私有配置。owner/deployment/清单/目录/PID创建时刻/agent绑定，Attach与agent均校验；工具只接纳本进程创建的handle。清单每行SHA256+相对路径；拒绝链接、越界、重复及漂移。

Agent从Instrumentation已加载类中定位唯一Quarkus/Application，共同classloader，核core实际代码来源与清单SHA。调用blockingExit之前注册shutdown hook，等待本次COMPLETED回执写入，且等待控制器观察Attach helper终态后写入绑定本请求的CONTROLLER_RELEASED。两者齐全才允许框架最终VM halt，防System.exit切断Attach原生回复。agent不直接System.exit、不发signal；Quarkus自身在生命周期完成后可System.exit。失败写FAILED，绝不冒认正常关闭。控制器在释放前崩溃可能保持VM pending，需要未来持久接管，不能称进程已退出。

验收：实际新PG和Keycloak启动；获取真实管理员token、创建realm/user并取得真实access/refresh；错误owner/代数/清单/PID-start拒绝且原实例仍可用；实际agent内部错误拒绝；已有回执不覆盖；重复停止同promise；STOP_STARTED/COMPLETED、真实exit0/nullsignal、Keycloak停止日志、对应SQL客户端归零；同库同origin新副本重启，realm/user UUID和refresh会话实际延续后再次正常停止。私密token/配置/分发不提交Git。清理只处理此测试拥有且身份核验通过的资源，不强杀。

本层不宣称跨PG迁移、所有请求排空、helper ACK丢失、控制器崩溃接管、原实例停机、生产切换完成。整库认证加密迁移与当前权威围栏后续继续，完整图文视频交付仍后置。

依据：本机core JAR经javap核为3.40.1；[Quarkus退出实现](https://raw.githubusercontent.com/quarkusio/quarkus/3.40.1/core/runtime/src/main/java/io/quarkus/runtime/Quarkus.java)、[Application停止实现](https://raw.githubusercontent.com/quarkusio/quarkus/3.40.1/core/runtime/src/main/java/io/quarkus/runtime/Application.java)、[生命周期管理](https://raw.githubusercontent.com/quarkusio/quarkus/3.40.1/core/runtime/src/main/java/io/quarkus/runtime/ApplicationLifecycleManager.java)、[Keycloak配置优先级](https://www.keycloak.org/server/configuration)。

# 身份运行时正常停止：开发与运维说明

此适配器用于Windows/JDK21上**新启动的隔离Keycloak 26.8.1开发实例**，绑定Quarkus 3.40.1。它是身份库迁移的前置能力；原本机实例、Linux服务器和生产切换尚未接入。

## 调用顺序

1. 在owner-only短路径父目录构建 `buildIdentityLifecycleToolsV1`。JDK java/javac/jar及四个选定DLL、Java输入、class和agent JAR保留哈希见证；这不是完整JDK供应链证明。
2. `launchIdentityLifecycleV1` 使用全新的owner和私有分发。当前保护范围仅loopback：新身份PG端口20000–29999，新HTTP端口30000–39999；没有任意旧PID入口。数据库需预先建好且专属于此次实例。不能传入原45432/8081配置。
3. 等实际OIDC discovery readiness，再 `bindIdentityLifecycleV1`。绑定包括OS创建时间，不能用文件中的PID代替存活身份核验。
4. 停止用 `stopIdentityLifecycleV1`；重复调用返回同一promise与不可变证明。停止意图、agent STARTED/COMPLETED、控制器释放记录、真实进程close事件和最终证明均持久保存。

`scripts/verify-identity-normal-stop-v1.mjs` 创建真实自有PG/角色/数据库和两个新实例，测试真实用户及refresh会话。运行一次产生唯一工作目录；观察超时后继续检查同一运行句柄，不直接重跑。`scripts/verify-identity-normal-stop-cleanup-v1.mjs <runNonce>...` 只读核清理。

## 停止协议

调用者和agent均核owner/deployment/整分发与配置清单/目录/进程创建时刻/agent SHA。agent从已加载类寻找唯一Quarkus运行时，用其classloader调用blockingExit。shutdown hook等COMPLETED落盘和控制器确认Attach helper终态后的CONTROLLER_RELEASED，然后允许框架最终退出。该顺序避免VM退出截断Attach回复。agent不直接System.exit、不向目标发signal；**Quarkus框架本身可以正常System.exit**。

只有真实exit0/nullsignal、原请求完整回执、整不可变分发校验和Keycloak停止日志齐全，才接受正常停止证明。QA另核身份数据库连接归零。回执/配置/分发漂移均拒绝，不能重写旧见证来继续。

503份复制文件包含lib/bin/providers/themes、版本/license/readme和新配置；原data与conf不复制，新data保持独立，cache=local。配置含秘密，所有运行文件保留私有权限，禁止将work/.local/分发/token/账号文件提交或放入最终说明书。

## 尚需完成

本层只证明同库正常重启；没有证明跨PG整库迁移、撤权/登出在迁移后不复活、全部请求排空、helper回复丢失注入、启动失败或控制器崩溃接管。控制器在release前退出可能让目标VM停留在shutdown hook；目标仍活着就继续核同一handle/回执，不能以超时当作终态或强杀服务。原有实例接管、身份权威独立围栏、Linux/JRE-only流程和正式生产控制器仍待完成。

最终用户PDF/DOCX图文与演示MP4继续按同一验收版本制作，此文不是最终用户手册。

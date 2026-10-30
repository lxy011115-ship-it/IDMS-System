# 核心依赖控制器 V3

该版本连接两个 PostgreSQL 实例、Keycloak、Flowable 和业务应用组的实际生命周期。它提供核心启停管理；设备代理、MQTT、AI 网关与模型服务仍需后续显式登记，不能把本阶段作为整套系统验收。

## 接口与运行条件

`createPlatformDependenciesV3` 位于 `scripts/platform-dependency-controller-v3.mjs`。输入沿用 `PLATFORM_DEPENDENCIES_V1` 清单，字段由 `platform-dependency-config-v1.mjs` 严格验证。调用方先取得 API，再等待 `ready`；可通过 `status()` 查看状态、`resources()` 保留本次创建的实际句柄、`close({requestId})` 请求逆序关闭、`closed` 等待最终结果。

同一停止操作使用相同 UUID。正在执行时重复调用复用同一个 Promise；不同 UUID 被拒绝。若数据库因其他客户端未退出而返回 `BLOCKED`，应先处理该已确认的客户端，再使用原 UUID 重试。控制器不会强制终止未知连接、删除 PID 文件或根据历史 PID 接管进程。

启动顺序为 PG、身份服务、工作流、业务应用。停止顺序相反，先撤销网站入口并排空应用，再关闭 JVM，最后检查 PG 客户端及 prepared transactions 并执行正常 smart stop。创建服务前取消已有单元验证；核心启动中取消和完整故障矩阵仍待专项原生验证。

Windows PG 需要非管理员 token。`verify-platform-core-windows-v3.ps1` 是固定程序和参考资料的测试包装器，持有实际创建句柄并固定自身与执行源摘要，不是接管生产进程的通用启动器。应用生命周期记录与控制器记录使用同一私密父目录下的独立 UUID 目录，避免此前 Windows 嵌套路径达到 261 字符时的 ACL 工具失败。

## 保持业务绑定

对账服务的工作流及预约指纹包含服务 origin。重启已有资料时，不能仅修改客户端 URL 而保留原领域标记。本次隔离测试先正常关闭原测试代理和旧 JVM，再让新 Flowable 在原代理的公开回环端口启动。客户端配置图、已保存指纹和凭据见证保持不变，原安全校验正常执行。

此前 `0b99c9d3e417` 的失败和清理证据保留。离线计算确认，原配置的两个指纹均匹配，改写端口后均不匹配；本次没有通过更新旧领域标记或放宽校验来制造成功。

## 已验证范围

Windows 案例 `b6049e0503f8` 实际完成 31 项检查，原生执行与独立清理均退出 0。核心五个组件共同启动后，两租户 HTTP 上下文和原工单保持；新增维修命令通过直接运行的真实 Flowable 完成同步。已确认的独立 SQL 客户端阻止最后一个业务 PG 停止时，没有发出 PG 停止 helper 或停止意图；释放客户端后，同 UUID 重试正常关闭。

独立证据包括三个 PG 目录干净离线、七个业务数据库目录移除、五次工作流正常停机与 26 个池关闭、JDBC 归零。案例登记的 20 个根 Node 和 48 个应用成员均取得实际终态；其中核心应用组九个成员正常退出。计数也包含本案例此前的故意故障和部分启动测试，不代表所有测试进程都正常退出。

876 个执行输入、此前 622 个受管文件以及原工作流 JAR 保持原字节。资料来自公开批准模板，使用显式后台会话；这里没有声称完成浏览器登录、原企业私有数据迁移、现场设备或生产部署验收。

## 复现入口

先按现有运行环境说明准备 Node.js 24.20.0、PostgreSQL 16、JDK 21、Maven 3.9.11 和 Keycloak 26.8.1。Windows 固定测试包装器使用 `%LOCALAPPDATA%/IDMS/runtime` 中的工具及系统安装的 Node.exe；运行前应核对包装器要求的路径和摘要。

```powershell
node scripts/prepare-platform-core-public-baseline-v1.mjs
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/verify-platform-core-windows-v3.ps1
```

参考资料只有公共模板生成的沙箱数据。准备命令遇到已存在的相同资料只核对摘要，不覆盖不同资料。原生执行完成后，使用该次实际 nonce 运行 `verify-runtime-application-suite-cleanup-v8.mjs` 独立核验。Linux CI 使用同一 V8 验证入口及独立清理入口；Linux 结论以对应提交的真实 CI 结果为准。

原网站、云端运行版本和公网域名不会随测试自动切换。当前仍只做未备案条件下的服务器准备，最终用户手册和演示视频尚未交付。

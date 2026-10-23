# MQTT broker 的实际归属与正常关闭

这是既定平台依赖控制器计划第 5 步的继续实施。现有 Mosquitto 2.1.2、双向 TLS、按边缘身份和租户主题的 ACL 保留；不把测试 broker 或原进程当作新归属进程。

## 方案与边界

采用固定 Mosquitto 程序、显式私密运行配置和实际 ChildProcess 句柄。系统服务迁移需单独处理既有资料、安装权限与服务归属；替换成简化 Node broker 会改变当前 MQTT 实现和行为；直接公开 PID 停止接口不能满足既定归属要求。本步骤沿用既定控制器的固定组件方式，不接受外部 PID、任意程序或任意命令。

Windows 使用 Mosquitto 2.1 已有的 `mosq<PID>_shutdown` 命名事件。内部固定控制程序同时打开实际目标进程句柄，核对父进程、创建时间、程序、配置命令行及自有回环监听端口，发送前再次检查原句柄仍在运行。请求只来自创建者保存的实际句柄与私密绑定，内部控制程序还要求调用它的父进程正是 broker 创建者。不能用 `mosquitto_signal -a`、通用终止、第三方 PID 或单凭工具 exit0 宣称关闭。

Linux 由本创建者保留实际 ChildProcess，核对 `/proc` 的父进程、starttime、程序与自有监听 socket，再由该实际句柄发送 Mosquitto 正常处理的 SIGINT；发送检查与动作之间不插入异步等待。实际退出及 stdout/stderr 全关闭才是终态证据。

## 配置和就绪

运行配置只允许指定程序目录、一个回环监听端点、固定 CA/服务证书/私钥、专用健康探测证书以及声明的边缘/平台 ACL 绑定。校验器拒绝未知字段、任意程序、命令钩子、通配主题、跨通道 ACK、路径别名、错误证书用途或密钥不匹配。

broker 配置及 ACL 由固定生成器创建在本次私密目录，禁止 include、任意插件、任意启动参数或继承旧 `.local` 配置。健康探测账户只读写本次 owner 的专用主题；broker 不持有业务边缘和平台客户端私钥。实际自有监听确认后，使用固定证书及服务证书指纹完成 MQTT5 CONNECT、SUBSCRIBE、QoS1 收发和探测客户端正常断开。仅 TCP 可连接不算 READY。

## 关闭与失败

停止前复核源码、程序、配置、证书及当前进程绑定。漂移时先拒绝，不发送关闭事件；恢复原字节后可用同一 requestId 重试。接受后单次发送，重复调用复用同一操作；原进程实际退出0、管道关闭且控制证明匹配才是正常停止。未创建服务前取消和创建后取消分别记录，不能把创建后短暂监听写成未监听。

父控制器中断、写证据失败或无法确认目标时保留未证明状态和已创建句柄，不再创建一组掩盖遗留进程。父丢失自动退役和服务重连归属须有实际协议与验证后才能公开相应结论。

broker 正常退出不自动证明全部业务消息排空。后续平台接线必须先撤销采集入口，排空并停止实际边缘、平台传输及其租约/接收工作，再关闭 broker；保留持久 spool 与已提交 ACK 语义。当前手工上传路径和可选 AI SHADOW 均不改变。

## 验证

先用全新隔离 mTLS 资料和随机非原端口验证 Windows 正常通道及错误绑定拒绝。随后验证实际认证 QoS1 交互、错误凭据/ACL、配置漂移、同请求重试、启动冲突和第二个无关 broker 保留；Windows/Linux 分别取原生及独立清理证据，再进行平台和边缘组合。不得把纯校验、模拟器、一个服务正常退出或原有预测组合当作全部依赖已完成。

资料依据：

- https://mosquitto.org/man/mosquitto_signal-1.html
- https://raw.githubusercontent.com/eclipse-mosquitto/mosquitto/v2.1.2/src/signals.c
- https://raw.githubusercontent.com/eclipse-mosquitto/mosquitto/v2.1.2/apps/mosquitto_signal/mosquitto_signal.c

该设计仍保留全方案 A、原 D 盘私有资料恢复、容量/保留/OT/灾备/安全/商业/UAT，以及最终同版本中文图文说明与实操旁白字幕视频。域名未备案，只准备服务器，不激活公网。

# MQTT broker Linux 启动与正常关闭修复

本次后继接口为 `scripts/mqtt-broker-lifecycle-v4.mjs`，原生验证入口为 `scripts/verify-mqtt-broker-lifecycle-v5.mjs`。已执行的 V3 接口、V4 验证入口及历史成功、失败案例保持原样。

## Linux 运行依赖

原 Linux CI 的 broker 实际退出码为 127，尚未取得完整的 Linux 生命周期证明。对同一 Ubuntu 官方包的 ELF 分析发现程序需要 `libwebsockets.so.19`；原工作流只显式安装 cjson、dlt 和 wrap 库。修复候选补齐 `libwebsockets19t64` 和 `libmosquitto1`，并使用 `fetch-mosquitto-package-v2.py`。

下载程序先从软件仓库元数据选择包版本，核包 SHA-256 和包内名称、版本、架构，再提取程序。提取后以清理过的环境执行 `ldd -r`，记录库名、缺失库、未解析符号数、退出码及输出摘要。缺库或重定位失败时拒绝继续，不创建 broker。程序包不会安装为系统服务。当前缺库分析仍需新 Linux CI 实跑确认。

## 创建阶段关闭

监听端口出现后，Linux 还须从当前实际拥有进程的 `/proc/<pid>/status` 读取 `SigCgt`，确认 SIGINT 处理器已经安装，才允许绑定就绪或创建阶段正常关闭。解析器使用完整 64 位掩码；缺失、重复、畸形字段均拒绝，其他信号及忽略 SIGINT 不代表就绪。

这项检查与已有父进程、启动时间、程序、完整 argv 和自有 socket 校验共同使用。正常退出证明新增 `linuxSigintHandlerObservedBeforeStop`，Linux 独立清理要求其为真。不能通过放宽实际退出码或把 127 归成预期端口失败来通过验证。

## 本机证据与边界

Windows 新版实际通过 10 项单位检查、9 项原生检查及独立清理；封存 913 个执行输入，5 个 broker 进程全部结束，其中 4 个正常关闭、1 个预期端口冲突启动失败。公开摘要见 `docs/validation/mqtt-broker-windows-v2.json`。

这些证据验证了新增代码保留 Windows 的真实 mTLS、MQTT5/QoS1、ACL 拒绝、归属校验、配置恢复重试和停止隔离。它们不证明 Linux 已通过，也不证明业务消息已排空、边缘 spool 已保留或平台控制器已完成接线。云运行和域名状态保持原部署准备边界。

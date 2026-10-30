# MQTT broker 正常生命周期

本模块继续平台依赖计划第 5 步，保留实际 Mosquitto、双向 TLS 和已有按租户/边缘身份派生的 MQTT 主题。生产接口当前为 `scripts/mqtt-broker-lifecycle-v3.mjs`；较早入口保留了实施和失败证据，不用于新配置。

## 配置与接口

私密运行 JSON 固定为 `format:1`、`purpose:MQTT_BROKER_SERVICE_V1`，并包含 `toolingDirectory`、`host`、`port`、`server`、`probe` 和 `channels`。host 必须为 127.0.0.1；程序目录只选择固定名称的 Mosquitto，不能传任意程序或命令。

server 指定 CA、服务证书和服务私钥文件；probe 指定独立探测身份的客户端证书和私钥；channels 只声明 tenantId/edgeId。ACL 从既有 fieldMqttClientId/fieldMqttTopic 派生，不接收任意 ACL 文本或通配主题。探测身份只访问本 owner 专用健康主题，不能写业务遥测；broker 运行配置不需要业务边缘或平台的客户端私钥。

接口按以下顺序使用，停止只接受同一个返回句柄与可选 requestId：

```js
import {
  launchMqttBrokerLifecycleV3,
  bindMqttBrokerLifecycleV3,
  inspectMqttBrokerLifecycleV3,
  stopMqttBrokerLifecycleV3
} from './scripts/mqtt-broker-lifecycle-v3.mjs';

const handle = await launchMqttBrokerLifecycleV3({runtimeFile, workDirectory});
const ready = await bindMqttBrokerLifecycleV3(handle);
const current = await inspectMqttBrokerLifecycleV3(handle);
const stopped = await stopMqttBrokerLifecycleV3(handle, {requestId});
```

程序和材料目录由管理员显式提供可信输入。运行文件、证书、密钥和源文件拒绝别名、符号链接及多硬链接；程序与 DLL 字节封存。Windows 的固定系统 PowerShell 宿主可能由操作系统服务机制建立硬链接，另以固定路径、文件身份、链接数和完整 SHA 校验，不把这一例外用于配置、密钥或其他程序。

## 就绪与停止证明

Windows 内部控制程序要求自己的父进程就是 broker 创建者，核实际目标的父进程、创建时间、程序、配置命令行和自有监听端口。Linux 核实际 `/proc` 父进程、starttime、程序、完整 argv 和监听 socket。绑定还必须完成服务证书指纹校验、双向 TLS、MQTT5 订阅和 QoS1 回环/PUBACK，并正常关闭探测连接。

关闭前重新检查输入和归属。Windows 使用当前实际对象的命名 shutdown 事件并等待打开的原目标句柄；Linux 由原创建者持有的 ChildProcess 发出 Mosquitto 正常处理的 SIGINT。只有实际退出0、stdout/stderr 关闭、控制结果和保存证据相符才生成正常证明。重复停止复用同一个操作，不能靠超时、端口消失或辅助程序 exit0 推断成功。

配置漂移在写 stop-intent 之前拒绝；恢复原字节后允许同 requestId 重试。创建后取消可能已经短暂监听，证明会明确记录这一点。模块没有公开 PID 接管或通用强制关闭接口。

## 已验证的范围

Windows 最终入口 V4 实际通过 9 项原生检查及独立清理，封存 907 个执行输入。5 个实际 broker 中，4 次正常关闭、1 次预期端口冲突启动失败；真实 QoS1 收发、ACL 的未授权 PUBACK、错误创建时间拒绝、配置恢复重试和两个独立 broker 的停止隔离均已证明。7 项本地单位检查通过。公开摘要在 `docs/validation/mqtt-broker-windows-v1.json`。

两次早期检查均在创建 broker 前拒绝，分别是打包应用的 LOCALAPPDATA 重定向和固定 PowerShell 系统宿主的硬链接。原案例、源文件和零 broker 清理结果保留。V3 的 Windows 9 项成功也保留；V4 增强了 Linux 实际命令行核对后重新取得 Windows 9 项与独立清理。

Linux 工作流会核对软件仓库元数据中的包 SHA，提取 broker 程序而不安装或启动 broker 系统服务，再运行相同原生入口并独立检查。Linux 结果尚未取得，不能由 Windows 9 项推断。

broker 正常退出不能替代业务消息排空、持久 spool/ACK 保留、边缘租约及生产采集入口退役。它尚未接入当前六组件平台控制器；父丢失退役、边缘/平台传输整合和启用的 AI/模型生命周期仍须继续。原站点和云运行版本均未切换，最终中文图文说明及实操旁白字幕视频仍属于整体交付目标。

原生机制依据：[Mosquitto signal 官方说明](https://mosquitto.org/man/mosquitto_signal-1.html) 与 [2.1.2 信号实现](https://github.com/eclipse-mosquitto/mosquitto/blob/v2.1.2/src/signals.c)。

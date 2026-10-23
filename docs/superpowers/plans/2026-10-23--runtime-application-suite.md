# 应用进程登记的实施与验证

## 已实现

正式候选入口为 `scripts/runtime-application-suite-v2.mjs`，配套 manager/child V2 与 config/registry V1。清单固定每企业四后台和全站一个入口；管理器自行 fork 固定脚本，绑定实际句柄、随机挑战、配置和权威摘要。SQLite WAL/FULL 持久登记；后台全 READY 后才开放入口，停止先撤入口再排空后台。启动取消阻止后续 fork，同编号 STOP 重传至确认，配置漂移关闭整组。

## 本机实际证据

2026-10-23，合并单元检查实际 19/19 通过。完整物理恢复案例 `6631d5b58f72` 使用 V4 QA，在原 20 项检查后实际完成两企业九组件运行、两企业真实治理/分析/独立复核/Flowable 建单及领取、SQL 持锁中的整组停止、原 Flowable commandId 重启恢复、配置漂移故意失败、父 IPC 断开正常关闭、部分启动取消，共 25 项；原生实际 exit0。

独立清理与额外终态观察均实际 exit0：A/C 两组各九个应用正常关闭，B 九应用在故意漂移后全部退出，D 实际只启动一个后台并正常取消；合计 28 应用退役。三个 PG 目录干净离线，七个恢复目标业务库目录移除，身份服务正常停止；四个工作流 JVM 共 20 连接池关闭、剩余 JDBC 连接零；17 个根 Node 进程退役。469 源文件摘要、原 568 受管文件和原工作流 JAR 保持。

V1/V2/V3 首次失败均保留，未改写为成功。V2 QA 的旧凭据读取、早于 Flowable 确认的业务状态预期由新 V3 QA 修正；V3 的连接断开终态观察由新 V4 QA 修正。Windows Node 24.20 的两个独立最小案例实际取得 exit0、两管道 close、disconnect，但未收到 ChildProcess close；新增观察器要求实际 exit、两管道关闭及 IPC 断开，非零/ENOENT 不冒充成功。相关 Node 事件的语义参考 [官方文档](https://nodejs.org/download/release/v24.20.0/docs/api/child_process.html)。V2 应用源字节在各轮验证中保持。

## 后续顺序与范围

将经过验证的源码管理于既有 wip 分支；Linux CI 使用同 19 项检查、完整 V4 原生验证及独立清理，结论以该提交的实际执行记录为准。准备云端新源码候选时另行核验归档和全部 Git blob。

本步骤是 PUBLIC_APPROVED_TEMPLATES_V1 的实际后端应用管理验证，未冒充浏览器操作或原私有资料的 Linux 迁移。旧 owner 移交、全部生产依赖登记、完整故障/密钥矩阵、容量/HA/PITR、真实设备/模型及最终图文视频仍属于完整目标。原 Windows 与云端运行版本保持，未备案域名只做部署准备。

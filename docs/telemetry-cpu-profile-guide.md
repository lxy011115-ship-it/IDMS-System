# CPU诊断与canonical v2边界

本轮使用实际TelemetryService.receive、原schema/角色/企业事务和默认任务预算，在独占QA库中定位接收CPU成本。1000/10000/45000审计历史是合成有效哈希链；每阶段预热1个新事件，再分别测3个新事件和3次同字节重放。传输通过直接调用方法并验证签名ACK，本结果不是MQTT/OPC端到端压测。

实际CPU样本来自QA进程自身的Node inspector Session，不开放网络调试端口，不附加原运行核心。原始.cpuprofile受限保留在.local专用QA目录。公开结果只保存原profile SHA、函数/文件self和inclusive汇总；14份成功profile已独立重读并重新汇总一致，另2份失败首轮原编码profile单独保留。

主矩阵成功证据为outputs/telemetry-transaction-cpu-verification.json，完整v2接收对照为outputs/canonical-stream-v2-receiver-verification.json，微测为outputs/canonical-stream-v2-verification.json。成功的对应QA结果与record-progress均独占写入，不同名覆盖重跑。`node scripts/verify-telemetry-cpu-profile-summary.mjs`可重复验证聚合逻辑；`python work/telemetry-cpu-profile-20261019/check-progress.py`可重复核对公开证据与源码。

完整接收对照在同一45000历史QA库中执行原/v2/v2/原，所有前轮实际事件和审计保留；每个版本获得6个新事件和6个重放耗时样本。阶段边界有预热4个新事件，总共实际新增16个点/回执/审计。v2子进程的CPU样本实际出现新编码器，父进程始终使用原编码器重算每个新持久根。所有完整一致性、审计、写后核对、旧幂等流程保留，重放没有新增事实或根更新。

最终公开阶段证明的receiverArithmeticMedians使用偶数样本中间两项平均。原始接收对照JSON的medianOriginalMs/medianV2Ms字段采用上中位样本（排序后floor(n/2)）；保留原始文件及统计口径，不拿两种口径混算降幅。少量样本、Profiler控制开销、当前主机其他负载都会影响数字；CPU时间含Profiler启停开销，查询分类时长包含驱动和JS行处理，不是纯数据库执行时间。inclusive时间有重叠，不能逐项相加。

新增server/canonical-stream-v2.ts保留原排序、undefined/稀疏值历史行为、循环拒绝和SHA格式，canonicalEqual/jsonWireClone直接重导出原函数。短字符串减少切片与emit调用，短键前缀缓存在一次遍历内，最多128条、每键最多128字符；大字符串继续分片，不构建全量canonical文本。缓存不随审计总行数增长。

scripts/canonical-stream-v2-loader.mjs是显式--import入口，已在本机Node24.20.0验证。它仅重定向同目录树原canonical-state.ts的消费者，v2重导出原函数时绕过重定向；默认服务不会启用。Windows程序化--import使用pathToFileURL(...).href，不能传C:\形式绝对路径。原文件、原配置、原运行源与三组长期协调器保持。

当前v2已通过实际接收事务QA，但原核心尚未部署，也未做启用v2的完整网站OIDC/范围/原件/工作流AI与并发业务回归。下一步先完成该隔离运行验证，再准备新的冻结运行源和原服务受控部署。完整企业图重建/审计扫描仍随历史线性增长，尚需增量事务与归档保留，不能把编码常数优化当作长期容量、HA、FIELD或整体验收。

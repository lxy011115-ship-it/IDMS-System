# 运营指标与冻结运营报告

本阶段继续方案A，指标能力标记为`operationalMetrics=approved-frozen-operational-v1`。当前为开发验收，完整商用目标仍ACTIVE。原质量规则、覆盖算法及冻结覆盖报告保持兼容。不同版本的实例应全部更新后启用新的报告类型；本阶段不证明滚动HA或跨服务灾备。

## 企业批准口径

在企业模板选择“新建运营指标定义”，填写已批准设备、计数单位、变更依据和明确生效时间。`operational-metric-policy`每设备一个编码族，同族不能改绑、不继承，保存/提交后必须由未参与作者或提交的授权人工终审。克隆与导入仅成为草稿。每版1..64条严格递增生效条目，定义版本`operational-metrics-1.0.0`；条目`definition:null`明确暂停，不能解释为通过。

首次声明INITIAL；未来调整PROSPECTIVE必须保持精确持久批准时刻及之前的条目；历史修改用RETROSPECTIVE_CORRECTION并说明原因。批准动作在实际事件时刻再次校验，跨边界失败时发布、旧版退役和审计原子回退。资料截止knownAt选当时已批准版本，再按生效时间取条目。批准时间是持久逻辑时间，不是可信授时或物理提交证明。

## 查询和来源

“运营指标与报告”填写设备、from、to、knownAt。时间须带Z或UTC偏移，`from<to<=knownAt<=当前时间`，窗口左闭右开且不超过31天，来源仅批准上传。先验证同RR完整业务根及当前设备授权，再还原DEVICE、PRODUCTION、STATE_INTERVAL、MAINTENANCE、QUALITY及其独立批准更正历史。后续更正、迟到批准或策略修订不改旧截止结果；先选最新有效更正，再按窗口筛选，不能让已移出窗口的旧行重新出现。

生产保留与窗口相交的完整期间，状态保留原相交区间，检验按measured_at选入。维修保留故障发生、恢复经过或完成与窗口有关的故障时间键下的所有已知行，含等待期，防止截断事件。每行带来源系统/业务ID、修订、批次和行号、原文件/批次摘要、批准及提交事件。一次完整输入最多25000条；超限、计数/来源/审批不可验证、预算失败或取消均不返回截断成功。四类明细可分页切换，完整汇总和输入/结果摘要保持。

## 生产与状态

完整期间模式FULL_PRODUCTION_PERIOD要求原planned_minutes等于期间跨度；日历模式APPROVED_CALENDAR要求独立批准的生效安排明确覆盖完整期间，计划RUN时长等于原planned_minutes，STOP中有RUNNING为冲突。窗口截断期间、期间中途换口径、状态缺口/交叠、计划不符均不猜值。计数保持原完整期间，不按时间比例分摊。状态输出运行、空闲、停机、缺口、交叠和停机原因时长；重叠不重复累计运行秒数。

可用率A=运行/计划，性能P=理想周期×总数/运行，计数良率Q=良品/总数，OEE=理想周期×良品/计划。零产量且计划/状态完整时OEE为0，P/Q零分母仍明确不适用；有产量却无运行或性能大于100%为冲突，不截到100%。混合节拍用理想时间聚合并按计划时长加权OEE，计数良率与理想时间加权质量分开。不同计数单位分组，不混加。

原始值经有限Number标准化，再用精确十进制有理数比较和累加，输出九位小数确定性舍入；单行计数超过Number安全整数不冒充准确，跨期间计数用精确十进制字符串。planned_minutes转换毫秒仅容许不超过百万分之一毫秒的表示尾差，不容许工程时长不一致。

## 维修与检验

维修事件身份明确为本设备+failure_time，同事件主动维修区间求并集，重复日志不会双计。MTBF=完整窗口RUNNING暴露/窗口内不同已记录故障时间数，缺完整状态/政策或无已记录故障时UNKNOWN，不输出无穷或健康结论。MTTR按最终repair_end落在窗口的完成队列，计算完整主动维修并集/完成事件数，即使维修起于窗口前也不裁短。初始等待、非主动恢复与恢复总时长分列。结束晚于knownAt不冒充已完成，不同事件恢复区间交叠给出歧义。运行与维修日志可并存，不擅自推断所有维修强制停机。

检验按批次/特性/单位/LSL/USL/生效条目分组，规格边界包含。跨来源重复的批次-特性-sample_no不当成独立样本或自动解释为复测，相关符合率保持未知。输出“已记录样本符合率”，不叫FPY、产品批次良率或质量放行，不替代生产good_count，也不在没有稳定性证据时计算Cpk。

公式基础见[Siemens OEE](https://docs.industrial-operations-x.siemens.cloud/r/en-us/insights-hub-oee/oee-basics/oee-standard-formulas/oee-standard-formulas)、[IBM MTBF](https://www.ibm.com/think/topics/mtbf)和[IBM MTTR](https://www.ibm.com/think/topics/mttr)。事件键、维修并集、完成队列及缺失处理是本产品明确的企业批准口径，并非厂商或ISO认证。

## 正式冻结与重算

预览后填写标题并“生成冻结草稿”。服务端只接受title/query/expectedInputDigest，重新取证计算；输入摘要变化返回409，客户端不能注入报告正文。新增运营报告复用migration5不可变追加表，无新增DDL；GENERATED→SUBMITTED→人工APPROVED/RETURNED/REJECTED最多三事件。作者/提交人不能终审；内容不编辑、不重提，修订另建报告。列表只验摘要链，打开或导出会校验全输入并独立重算。新旧报告列表和路由按类型隔离，当前范围先于正文、导出及旧幂等回执。

冻结正文`idms-operational-report-v1`保存完整`idms-operational-input-v1`、策略、日历、结果及摘要，规则`frozen-operational-metrics-1.0.0`不依赖当前日期/网络。原生JSON下载`idms-frozen-operational-export-v1`含全部正文与审批事件；页面来源例证最多5条，完整证据均在包中。可保留带UNKNOWN/CONFLICT的报告以记录不足，批准并不自动构成产品放行或设备健康结论。

离线执行：`node scripts/verify-frozen-report.mjs --file <报告.json>`，输入文件上限128MiB，同时支持旧覆盖包和新运营包。普通SHA和包内审批链证明内部一致性，不能证明外部签名、签发身份或独立可信时间；externalAuthenticity仍为NOT_PROVEN。版本化计算/实际固定向量不得静默替换，未来变更须保留v1重算。

接口详见API1.29.0：GET `/api/v1/operational-metrics`（section为PRODUCTION/MAINTENANCE/INSPECTION/STATES），以及`/api/v1/operational-reports`的列表、生成、详情、submit、approval与export。状态、时间、条件、计数单位和精确分子/分母应一并解释。

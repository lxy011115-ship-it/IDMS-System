# v4认证只读HTTP适配器

新增资产分页、审计分页、遥测回执追溯三个真正HTTP查询，读取采集领域的v4权威映射，不依赖旧SQL投影，不每页重建全历史。原站点仍是冻结913源v2，当前页面和其他接口尚未接入此适配器；全站v4切换与完整方案A继续。

## 接入顺序

1. 按既有迁移/采集说明，在已核验完整旧图及持久停写旧源的目标映射激活采集领域。不能让旧v3写者与v4共同写同一企业。
2. 在维护初始化代码调用 scripts/domain-read-activation-v4.mjs 的activateDomainReadCatalogV4(account,binding)。它完整验证当前payload，以旧effectiveRecords构造批准DEVICE目录，兼容旧devices的范围身份。目录74项等数字仅为本轮QA，不是固定业务规则。
3. 不可变目录分批准备，每批最多24项/估算4MiB；目录项全部证明重读后，一次CAS发布domain_head/read_catalog。准备中旧指针保持，失败不会暴露半成品；发布前持续核对ACTIVE和原治理anchor。采集只追加遥测/审计，可在此期间继续接收。新的治理、设备或导入写者必须同步更换anchor与目录；尚未实现这些写者，禁止绕过此约束。
4. 宿主核心以只读DB角色和其真实数据库/角色OID、目录摘要创建DomainReadApiV4，并通过createDomainReadHttpV4(existingAuth.context,readers)挂接HTTP。readers是服务器提供的租户映射，不能从请求选择数据库。部署须沿用既有createAuth的OIDC/会话实现和受管密钥，不接受演示头身份。源码工厂和可启动QA宿主均已实际使用；它不是已部署原站点的独立服务。

加密游标使用既有createAuditCursorCodec，但采用独立部署/用途命名空间，如DOMAIN_READ_V4；多实例必须使用同一受管key ring及部署绑定。加密内容还严格绑定DOMAIN_READ_PAGE用途、数据库/角色/目录、主体/租户、角色派生权限、范围、路由、页大小、窗口根、位置和30分钟期限。客户端不能提交任意root或namespace。密钥轮换沿用原codec保留旧解密键的规则。

## 路径与权限

| GET路径 | 参数 | 返回 |
|---|---|---|
| /api/v4/data-management/assets | pageSize=1–20，或cursor | 已批准有效DEVICE记录；按device_code稳定顺序 |
| /api/v4/audit | pageSize=1–20，或cursor | audit_order逆序、按现有dataScope语义可见的事件 |
| /api/v4/telemetry/receipts/eventId | edgeId和digest各一个 | 状态摘要、原审计及可验证原点；不返回原始拒绝报文 |

请求先经过真实OIDC/共享会话context和read授权，受限角色缺管理员scope直接拒绝，即使内部调用也不能利用旧helper缺scope的兼容行为。租户状态、当前control和当前目录在历史页前核验；UPDATING或目录anchor漂移拒绝。PAUSED可保留历史查询。资产/遥测的当前和历史资产范围均须允许；导入、工单、告警等审计沿用原范围和本人任务规则，逐个实体证明读取。不可分割混合范围批次不会泄露。

每页在一个REPEATABLE READ连接核对当前及历史根证明；仅本请求缓存，最多256键/16MiB正文读取。审计每次最多扫描48事件、返回20条，验证各事件旧格式摘要及页边界相邻链。verificationScope=MAP_PROOF_AND_LOCAL_CHAIN明确表示映射证明和局部链，不冒称每页重新核验全历史。隐藏事件可能产生空页，nextCursor仍推进；没有全租户隐藏总数响应。只在读取事务成功结束、目录后验通过后发送完整JSON；错误无部分业务正文。

回执按edge/event/digest直接读取，并使用旧verifySourceReceipt/verifySourcePoint、冻结来源配置对应治理时间树、别名原点和审计关系校验。输出拒绝状态摘要，不输出可含外租户身份、签名及任意私密字段的原始envelope。

## 真实验证范围

最终 work/domain-read-v4-20261019/82591f99be7e 用全新4库14角色执行完整旧图迁移、采集激活和目录发布。37批准资产/74目录项；原窗口87条审计与旧完整审计链逐条一致。3条新增真实接收器/PG提交后替换HTTP实例，原游标仍保留窗口，另一真实Node45364用相同受管游标密钥/只读角色读取原页，正确IPC停止且原生exit0。

54次带统计的成功读请求最高103逻辑键/157109值字节。37资产与旧effectiveRecords逐条一致，受限范围19可见；受限/本人任务审计与旧dataScope逐条一致，48隐藏事件形成空页仍可推进至结束。旧点和新点回执/治理验证通过；实际合法签名外租户拒绝报文含随机私密标记，HTTP响应未包含标记或原envelope。

签名、租户、角色、scope、主体、路由、页大小、期限、部署绑定及篡改游标负例通过；服务器认证但错误根摘要仍被证明校验拒绝。真实UPDATING/anchor漂移/目录切换在历史页前拒绝；真实回滚DISABLE TRIGGER仍污染保护epoch，历史读拒绝。只读角色没有apply_delta执行权限。

OIDC使用真实HTTP/JWKS和RSA签名fixture，不是本轮真实Keycloak集成。共享会话是两个宿主共用MemoryAuthStore中预建、每次重新验证签名令牌的会话，测试了跨宿主读取和删除撤销；不是新做了PostgreSQL加密会话部署/跨进程会话持久性。独立Node使用Bearer令牌和同key ring验证游标。原站点已有真实OIDC/加密会话另由原运行核验器复核，完整v4核心仍须真实Keycloak/加密共享会话再回归。

本轮2新增单元加原OIDC/共享会话/加密游标共13定向单元、268构件/全脚本/server-predictor类型通过；此前509/13全业务回归未重跑。测试时只控制自有Node业务时钟，不修改OS时钟；私密子配置已删除，4轮已知QA各4库14角色精确清理，不使用FORCE或终止未知后台。首次扩展负例误把旧signature放进重新签名输入，接收器正确不ACK；该失败轮资源已清理，改成无signature输入后fresh完整验证通过。

## 后续

下一项接入来源治理/批准/导入等业务写者，要求先关闭采集、准备新索引和目录、原子激活业务变化及旧格式审计；再接设备数据中心更多查询、六原文件/CSV、全HTTP授权/范围/游标、工作流/AI与全量备份恢复。原913站点不切换；历史根保留删除、真实FIELD、跨服务HA灾备、安全、模型/RUL及SaaS/私有化/许可等完整目标继续。当前所有旧根仍保留，30分钟游标期限不等于已实现保留期。

可重复证据校验：`python work/domain-read-v4-20261019/check-progress.py`。record-progress.py只发布一次，成功后不得重跑。冻结的14基础/12迁移/25恢复、采集24当前+10基线及其校验修订保持；本轮14精选源另行发布。

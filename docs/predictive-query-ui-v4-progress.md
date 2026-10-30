# 预测读取与页面阶段进度

2026-10-21：新增当前设备、健康快照、告警、输入证据与设备任务接口，以及独立 `/predictive/` 工作台。旧冻结站点、原运行服务、Git 主分支和云端未升级，`idms.xin` 仍按备案前服务器准备范围处理。

实库读取及控制回归：`work/predictive-console-query-v4-20261021/51feceade98b/verification.json`，27 组通过。实际 Keycloak、加密共享会话、QI HTTP、独立 APP worker、规则服务及 Flowable。新增验证范围过滤、脱敏来源、旧基线待对账、维护阶段、18 条新快照事实、原生回执审计、独立复核资格、设备事务索引、固定分页的身份/范围/筛选/目录/时效与创建后状态。API 身份使用真实 direct grant 夹具，不当作浏览器证明。

实际 Cua 浏览器：`work/predictive-console-ui-v4-20261021/3cf3afca6121/verification.json`，12 项。Realm 从创建起禁用 direct grant，实际 S256 PKCE 登录工程师、审核人与受限用户；页面分析并展开 18 条事实、阻止自审、独立复核真实创建一条引擎命令；真实 held POST 在重载关闭后不能接受、真实接受丢回复后重载恢复原命令；维护及暂不可用保留草稿；另一标签切换受限用户后旧详情不能回填，旧身份草稿与恢复视图清空；1440/390/320 实际截图及根 clientWidth/scrollWidth 验证；实际存储仅允许恢复元数据。

浏览器自有会话已退出，3 个专属 realm Cookie、2 个自有恢复命名空间删除，原 localhost 会话 Cookie 数保持 0，viewport 恢复且仅自有 2 标签关闭。观察到的异常为 0，但事件缓冲截断，完整异常覆盖明确未通过，不能报告整个浏览器轮次异常零值。

早期 API `cb04c7e69081` 已清理，因夹具误期待完成后删除仍用于保护建单的 intent 指针失败；更正期待保留已完成任务后新 nonce 全过，未改旧输入。早期 UI `cf94630f1e9f` 因控制 stdin 结束而未验收，已清理；后用保持 stdin 的新终端及新 nonce。以上不冒充成功轮次。

当前内核、SQL、单元、类型、语法、历史保值及清理最终结果见公开 `validation/predictive-query-ui-v4.json`。仍为 WIP，不构成生产或完整商业验收。下一步为预测页面接入新的统一站点修订、浏览器独立 retry/原人重授及其余分支和完整异常覆盖，再安排旧根/宿主/outbox迁移与受控切换。

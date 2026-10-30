# 恢复重新注册与激活执行计划

1. 共用严格私密配置解析，增加RESTORING材料候选检查，只返回公共快照与绑定摘要；普通运行加载器保持ACTIVE限制。单元/真实恢复上下文验证。
2. v2计划绑定完整公开注册候选和材料摘要，旧计划后显式替换保留贡献者；当前作者/独立审批及真实目标完整祖先链核验。
3. 维护状态/视图/监督IPC接入注册候选和v2计划；只在最终激活事务创建新注册观察，旧v1可核验但不用于新激活。
4. 不可变激活意图/基线、受控原生ACTIVE发布和标记释放，最终SQL新注册观察/权限/LOGIN/审计/根/阶段同COMMIT；当前外态和材料最终重查。
5. 精确同操作的提交前回滚/文件复位和提交后结果恢复；真实未提交登录拒绝、控制者终止、COMMIT回复丢失及合法后续业务推进验证。
6. 实际新注册/激活后的OPCUA/mTLS/SQLite/PG新流和旧许可/ACK失效、离线CLI/历史证据全链；冻结和兼容，之后才受控切换正式核心。

以上为一个完整激活目标的顺序依赖。材料候选检查不是正式注册/审批/激活的替代；后续步骤未通过时保持目标RESTORING，原服务不部署FIELD。

当前实现：第1项、第2项的v2计划及第3项视图/监督入口已实现。第4项增加事务内精确RUNTIME权限准备和原生ACTIVE/标记发布底层，第5项验证实际未提交登录拒绝、控制者终止回滚、同attempt重装marker及RESTORING CAS；最终源全组合验证后记录阶段证据。正式新注册/激活审计/root/ACTIVATED同COMMIT、当前外态最终复查、真实TLS材料和提交后结果恢复协调器，以及第6项新流仍未实现。不能把底层子条件当激活验收。

本阶段第4/5项进一步实现：不可变activation baseline/attempt/prepared/result、真实注册观察+激活审计/root/seq/ACTIVATED与ROLE的事务准备、原生发布后当前外态/材料复查闭包；提交后精确只读上下文重新认证整个归档和原记录，核验唯一审计与物理前缀/当前根并恢复固定结果，允许正常业务继续。最终固定源的隔离QA实际COMMIT/进程终止/新应用领域命令和结果缺失恢复已通过；另同源Chrome审批、未提交两审计回滚和真实外部流程推进拒绝通过，492单元/262构件通过。最终真实TLS材料/对端、协调器/操作命令、wire丢回复和第6项新流仍待完成，不能把内部COMMIT测试当全部激活验收。

实际材料门槛继续：已实现固定完整edge/intake材料检查、私有随机MAC/短期cap、真实UA认证只读/实际两角色TLS及无证书负试验、ClientHello早票据/PSK阻断和不替换正常MQTT连接，prepare可选接入attempt-v2并在原生发布后复读。真实材料跨归档/非空恢复/独立审批/COMMIT/回执首轮通过，最终credential drift拒绝、Chrome独立审批、外态漂移拒绝及未提交回滚恢复已通过。最终总协调器/activate-recover命令（强制v2）、wire故障及真实新流/旧lease/ACK全链与离线CLI/冻结仍待完成。

正式协调器接入：新增当前授权/状态解析/协调器及独立activate-recover CLI，强制材料v2、精确plan/facts、先认证再publication、未知COMMIT先关闭旧SQL再新上下文分类；回滚恢复要求新attempt，已提交仅当前授权下恢复固定回执。新隔离组合已验证真实提交前kill、权限撤销优先、完整祖先/事实后重装围栏，以及实际网络丢弃COMMIT CommandComplete后自动确认提交；不使用生产测试hook。继续真实新流与旧lease/ACK隔离、离线CLI/冻结/受控部署。

第6项正式新流：新QA分支用生产主HTTP/MQTT runtime和SDK真实源2点2回执替换旧synthetic初始样本，source实际RESTORING后机器拒绝/接收所有权释放并关闭，再完整归档恢复及正式activate；新目标检查旧签名/队列、旧事件registry拒绝、新COMMIT前不可见和失回复同receipt。最终须固定真实机器URL且使用canonical旧/新stream队列，并运行实际边缘CLI续sequence；联合验证已通过：真实源2点/2回执跨完整恢复及正式激活，SDK新2点与正式边缘CLI规范队列续2点至总6/6，新队列ack4/旧队列pending2保持，离线edge启动拒绝不改队列、旧event按registry拒绝及Write/Call0。仍不视为已commission，独立证据离线重算/冻结/受控部署继续。

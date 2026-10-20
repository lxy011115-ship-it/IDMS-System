# 恢复激活提交前的权限与文件围栏

恢复新注册候选已有v2计划和独立审批。激活需要同时满足可读取的ACTIVE控制和数据库应用访问条件。本阶段实现这两个条件之间的底层提交准备；已增加真实注册/激活审计事务准备与独立提交后回执模块；最终包含TLS材料核验的激活协调器尚待接入，没有新增面向运维的activate命令。

`stageFieldRuntimePrivileges`仅接受已开启事务且当前/session主体均为实际idms_bootstrap的连接。先完整核对FROZEN角色、成员、数据库和逐对象权限，再在调用方事务内恢复应用/迁移LOGIN、迁移对owner的显式SET权限、编译运行逐表和序列权限。owner始终不可登录，backup原只读不变。复用现有基础和FIELD模块安全校验器及完整角色策略，返回精确数据库/角色绑定；不自行提交，调用方失败时必须回滚。

`FieldActivationPublication`是authority原操作锁下的文件原语。公开的不可变publication记录绑定真实原操作SHA、同宿主/集群/路径、批准阶段和plan ID/SHA、注册与私密配置SHA，以及完全确定的RESTORING/ACTIVE正文。ACTIVE沿用已批准新恢复身份，清除operation/previous字段，采用记录中的时间。原始恢复意图/标记和旧restore/review结果保持原始字节。它不认证用户、不读取当前流程、不自行判定可以激活。

发布使用已有Windows WRITE_THROUGH原生辅助进程和所有者PID/创建时刻/提交管道围栏：CAS替换控制，再将精确原标记移动至本attempt的released记录。SQL尚未提交时，普通配置加载器可以读到新ACTIVE身份，但真实应用/迁移新连接仍应因NOLOGIN被拒绝；已有连接也不能看到未提交写权限。最终协调器须在这之后重查当前主体、作者/独立审批、流程、策略、实际材料和文件状态，最后提交SQL。成功的SQL COMMIT才开启访问。

提交前控制者终止后，SQL连接关闭回滚权限。后续只能由精确同操作/同attempt的协调器，在真实数据库仍是原APPROVED阶段且完整FROZEN策略成立后，调用底层rearm：先原生移动原released标记回锁，再CAS恢复原RESTORING。中间若CAS竞争失败，标记仍保持关闭；未知控制、损坏记录、未知activation文件、别名/硬链接、数量/大小越界均拒绝并保留。当前普通resume继续拒绝未知ACTIVE，没有为了新流程放宽。

rearm原语本身不判断数据库提交状态，不能直接作为操作员恢复命令。正式ACTIVATED已经提交时，通过独立receipt上下文重新认证整个归档、原恢复/审批记录及实际数据库/角色OID，校验唯一激活审计、初始物理审计前缀、当前完整根与编译RUNTIME权限，再补写结果。允许正常业务已经继续，不再回到RESTORING。当前该模块可供最终协调器复用；真实TLS材料/对端核验、操作命令和新流全链仍待实现。

本阶段独立权限QA验证真实事务回滚/控制进程终止和真实COMMIT后故意不发成功回复；后者只提交权限，没有提交正式注册或激活审计。完整归档/非空Flowable/独立v2审批组合则验证真正的原生ACTIVE未提交窗口和同attempt文件恢复。该组合仍回到RESTORING，不启动正式FIELD或业务写入。详细结果以对应进度JSON和源码SHA为准。


## 注册与激活事务及提交后读取

`prepareFieldActivationCommit`在原APPROVED/root锁/完整恢复上下文中重新核对审批链及plan-v2、当前JWT与独立批准者、当前作者、完整当前Flowable、30分钟计划期限、精确私密材料和当前策略。实际调用既有注册观察函数，追加唯一激活审计；注册和激活两条审计、root+1、sequence+2、ACTIVATED阶段与精确LOGIN/权限变更全部在调用方SQL事务内。32个其他实体关系、旧物理行/根/运行视图与序列定义保全先逐项验证。

immutable baseline/attempt/publication记录在SQL变更前写出；随后保存prepared witness，封住完整初始facts、原始微秒根和准确ACTIVATED正文。原生ACTIVE/标记发布之后，返回的revalidateBeforeCommit闭包重新读取材料/文件记录、核查当前作者/批准主体/工作流、期限、待提交阶段、精确RUNTIME及未知目标连接。此模块不自行COMMIT；真实TLS材料/对端检查仍须最终协调器加入，当前没有操作入口绕过此门槛。

`openCommittedActivationContext`通过新的精确op/attempt只读清单入口重建上下文：实际已持久publication/ACTIVE/原released标记、整个GCM归档、完整原restore records、target配置绑定、同集群、实际数据库及4角色OID、locale和6会话设置，独立root与backup同一RR快照。不装marker、不发布文件、不放宽普通resume，也不会为了读回执开启账号。

`verifyCommittedFieldActivation`要求实际ACTIVATED与prepared正文一致、2条真实事件/序列及初始整个物理审计前缀匹配；原32关系的历史事实和完整review祖先/原VERIFIED锚点仍需核对。当前业务通过现有整根、字段模块和编译运行权限校验；结果只记录初始激活phase/事件/根版本，所以正常业务继续推进后仍可恢复同一结果。已有冲突结果/损坏历史不修复。该底层验证不替代最终操作入口的当前用户授权，尚未发布面向操作员的activate或激活恢复命令。

隔离QA使用真实当前OIDC/Flowable及非空恢复：准备后撤销作者权限即拒绝并回滚；原生发布后真实COMMIT，未写结果前终止控制进程，再从新上下文认证归档并恢复；实际新应用连接执行经当前身份验证的正常createTemplate领域命令，根/审计继续推进，回执仍可补写且不重复审计。提交运行与Chrome审批/外部推进拒绝运行分别记录；本模块尚未进行wire级COMMIT丢包、实际证书/对端、新流或正式部署验收。


## 实际材料的v2尝试

prepare可用固定materialConfiguration内部创建短期FieldActivationMaterialInspection，核查真实UA只读认证、EDGE/PLATFORM TLS及材料绑定，使用activation-attempt-v2写入完整公开/opaque证据；实际激活审计和数据库phase通过attempt SHA封住它。原生发布后的最终闭包重读材料并检查同一私有能力、TTL及当前外态，调用者finally关闭inspection。具体配置、无MQTT连接替换的证明及TLS 1.3能力限制见[材料核验](field-activation-material-guide.md)。最终操作协调器尚未开放，必须强制v2；旧v1仅保留历史和内部兼容，不能作为新入口省略材料核验的选项。

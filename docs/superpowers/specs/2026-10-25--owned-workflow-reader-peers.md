# 原工作流只读引擎的实际连接持有能力

完整方案A继续；本阶段解决运行中只读引擎无法与当前根维护共存的问题，不授予人审、正式登记或现场启用权限。C34原源全事实基线不变。既有冻结源码不改，新增reader v2及独立工具/生命周期版本。

## 选择与边界

采用原生命周期创建的JVM、窄本地attach agent和平台MBean。HTTP维护接口会新增可访问的控制面；依据角色、application_name或外部PID列表则不能证明连接实际由原引擎持有。后两种方案均不满足现有所有权要求。

保持普通reader配置format1/purpose不变，核验原复制配置的SHA。原owner/deployment/start/jar/directory及工具SHA在每次操作前后重验；不创建JMX连接器、不接管已有进程、不终止外来SQL。

## 数据流与状态

1. 仅新增服务注册固定MBean；固定ACQUIRE/PROBE/CAPTURE/RELEASE操作，严格请求字段、UUID、租户、大小。控制面不暴露HTTP路由。
2. ACQUIRE先排空原HTTP快照，之后新快照返回503。每租户两个原worker线程，各自开启原Spring只读REPEATABLE READ事务，持有全部两池槽。实际SQL读取backend PID/start、DB/role OID、server identity和事务属性，核查原ACL。全池持有后才可报告HELD。
3. PROBE在每个原线程/事务上重新执行SQL，不以缓存PID冒充活连接；CAPTURE通过原线程执行完整Flowable/SQL快照，同一算法供HTTP使用，不另外开连接。
4. RELEASE在各原线程上设置rollbackOnly，等待原事务真正结束和worker退出；仅退役本服务原池连接，检查池active/idle/total归零后恢复HTTP。失败或超时保持不确定状态，不能声称已释放；重复同lease的操作可观测/恢复，不能创建替代租约绕过。
5. Node能力以私有WeakMap绑定原JVM handle和原复制配置；不接受PID/角色列表作为能力。对bootstrap实际pg_stat_activity的逐行身份比对在能力原PROBE前后执行；外来会话拒绝且保持存活。最终PG后台退役须bootstrap再次核查。

## 故障与验收

真实两租户、各两连接、活跃及关闭工单、完整命令链；持有期间HTTP拒绝，原事务CAPTURE与原HTTP结果一致，SQL无写权限。伪造能力、配置漂移、不同租约、重复请求错配、池部分借用失败、attach回复不明及外来连接必须覆盖；允许重查同原操作，不把超时当完成。全部业务表/序列不变，原JVM正常停止、池关闭、PG正常停止。Windows受限原生进程与Linux分别验证。

## 阶段结论口径

只有实际对应检查通过才能报告原reader能力已实现；未组合C34恢复协调器、真实审核人和正式启用前，recoveryReviewIntegrationComplete/formalFieldActivationGranted/fullGoalComplete仍false。原始业务证据和凭据不进入公开源码或日志。

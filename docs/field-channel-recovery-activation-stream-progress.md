# 正式恢复激活后的真实采集流进度

现场恢复第6项已验证实际源流、完整归档恢复、正式激活和新流及正式边缘进程的联合链路。新增两个严格限定自有目录/数据库的QA辅助模块，复用原主HTTP/MQTT运行处理器和正常SDK/队列/边缘入口。普通旧synthetic source fixture分支保留，不把历史协议声明样本改称真实读取。

源端实际原初始化ACTIVE文件保持，机器签发/真实用户名认证加密OPC UA读两点、HMAC事件、WAL/FULL SQLite与mTLS到PG，实际COMMIT后得到两个真实签名STORED ACK，故意不应用到旧队列。源进入原生RESTORING后机器接口503无签名、接收连接退役/所有权释放；旧核心/SDK关闭后完成冻结与整个35关系GCM归档。源库不可连接时新目标恢复并保留两点两回执及完整历史，4种工单/15实际outbox与当前独立Flowable一致，实际OIDC独立plan-v2审批和正式activate完成。

源端读之前固定真正机器URL，目标复用端口；不以SDK参数覆盖port9。设备/点表/profile/证书/请求键/事件键/签发键不变，实际源/目标数据库绑定不同，请求键和原受保护注册观察SHA直接核对。正常edge-directory为旧/新binding选择不同canonical stream文件，保留旧队列metadata/payload/digest及两条pending，不重置sequence。旧历史事件和ACK仍能验签；旧ACK不能清新队列，新授权不能清旧队列。旧lease经过完整恢复自然过期，实际签名deny为FIELD_LEASE_EXPIRED并报告新registry；旧签名check不能用于新lease。有效历史排队事件实际在prior receipt查询之前按FIELD_CAPTURE_REGISTRY_CHANGED拒绝，旧raw点/回执保持。

目标SDK新读两点后，暂停真正FIELD_COMMIT，外部连接仍只见恢复的两点两回执、无新业务ACK、SQLite仍pending2，broker PUBACK不清队列。COMMIT后真实STORED ACK才清确切事件。第二点实际COMMIT后丢弃应用结果，点/回执已持久而SQLite仍pending；同一payload重试恢复原receipt/audit ID，点/回执/审计/root/sequence不重复。序列由正常只读backup角色检查，未放宽app角色权限。

随后关闭SDK和它的SQLite/MQTT，真正运行services/field/index.ts --config同一配置 --once，在同一新队列续sequence3/4，retainedStreams=1并正常完成退出。最终目标6点6回执，新队列4ack/0pending，旧队列2pending原样保留。关闭核心后真正offline edge启动有界失败，所有队列不变。正常新增数据后正式recover仍在当前身份/完整当前Flowable检查下返回原激活回执，真实外部流程推进之后拒绝。UA服务合计15次Read、Write/Call均0；全部核心/SDK/UA/MQTT/SQLite/自有数据库角色/用户和引擎资源真实关闭。

开发验证保留两项原安全边界：已有真实Flowable工单的核心必须配置真实workflow客户端，不能关闭配置走本地fallback；app没有sequence SELECT，验证改用既有只读backup身份。固定源最终全链通过，496单元、262运行构件及全MJS语法/类型通过。77个此前构件保持、6个明确扩展，23个实现与所用运行代码SHA；本轮未改生产算法/权限/原生PS，也未重跑其已保留的8故障历史证明。原运行/数据/角色、431旧源码/两旧jar、66契约及十轮双份冻结fresh通过。

本轮为自有回环peer的真实协议和生产代码路径测试：源政策为领域fixture，恢复计划审批为实际OIDC/Flowable；主运行人类路由用demo模式，机器接口仍执行正式请求/签名/当前准入校验。无外部物理硬件attestation，无原正式FIELD部署，无新最终冻结快照，不是生产commissioning。offline edge启动拒绝不替代独立证据离线重算工具；该工具、最终证据冻结/受控部署、跨服务引擎DB灾备、大库、跨宿主/Linux、OS隔离/认证外部防回滚及完整商业范围继续，目标ACTIVE。

详见[新流与边缘操作说明](field-recovery-new-stream-guide.md)。本公开进度及JSON在项目与聊天outputs双份一致，不含私密配置、token、密钥、归档、SQL或原始日志。

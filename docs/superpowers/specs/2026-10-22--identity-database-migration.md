# 当前身份数据库跨PG迁移

原目标需要身份权威独立于业务PGDATA恢复。本层在两个全新自有PG和私有Keycloak副本执行完整迁移，保留原系统不动。延续已授权的开发/部署准备；既定方案内自主实现与验证。

realm JSON不能证明全部持久会话和撤销状态存续；物理整簇复制会保留业务/身份耦合。选择完整数据库custom pg_dump，保留全部受支持schema、对象、所有权/ACL、序列、large objects及数据，单独见证全局角色。pg_dump不包括全局角色；目标显式创建同名最小权限APP角色，验证原owner/权限后恢复，不扩大权限。整库数据与schema事实在启动目标前逐项核对。逻辑恢复允许内部DB/role/对象OID以及历史删列的物理attnum变化；有效列按原相对顺序的logical ordinal比对，列名/类型/默认值/约束等不能变化。不保留已删除列的不可访问历史物理字节。超出当前支持范围（外部连接/非标准表空间/扩展等）拒绝，不能无声漏掉。

独立源/目标由本模块创建并以WeakMap保留所有权，不能传入任意旧PG。capture直接调用已验证的自有Keycloak正常停止；核launch意图对应源DB与实际JDBC归零，再APP NOLOGIN、核全局角色约束和DB身份，完整dump前后事实一致，最后源DB禁连接。只读capture连接在禁全DB连接之前完成。不终止非自有连接。

新独立AES256GCM格式IDMSIDB1，随机独立key/IV，AAD绑定头和key ID；加密manifest绑定issuer/版本/source systemID/DB/role/逻辑代数/数据事实和dump SHA。篡改、错误key、错误issuer/上下文必须在创建目标DB之前拒绝。目标fresh DB恢复完整custom dump，保留原owner/ACL，比较完整事实后才启用APP LOGIN并记录镜像外目标权威代数2。此协议是新受管环境实现，跨进程崩溃接管与正式生产切换仍另待验证。

验收用真实realm/users/roles/user属性mapper、旧access/refresh及JWKS：同issuer新实例保留UUID与JWKS，原有效refresh继续，已撤角色/收窄范围保留、已logout/disabled refresh被拒；验证目标后续新授权可见且源NOLOGIN/禁连、旧代数拒绝。附加非public schema、序列和LOB用于证明整库范围。旧access JWT签名仍有效不等于当前授权有效，不能声称即时撤销离线JWT。普通动作的当前身份与生产expiry宽限要求继续。

依据：[PG16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、[PG16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)、[Keycloak缓存与持久会话](https://www.keycloak.org/server/caching)。最终图文PDF/DOCX和实际讲解字幕MP4仍按完整原目标后置。

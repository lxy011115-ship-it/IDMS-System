# 身份数据库迁移能力说明

本层为Windows/JDK21、Keycloak26.8.1/Quarkus3.40.1的**新受管隔离环境**实现真实跨PG16整库迁移。原运行身份库、原站点及Linux云服务器尚未迁移。

## 流程

- `createOwnedIdentityMigrationV1` 自行创建两个全新PG集群和同名最小权限APP角色，源库先创建，目标库保持不存在；无任意旧PG/旧PID接管入口。私有work保存独立加密key、账号和当前逻辑权威记录。
- 源实例由身份生命周期适配启动、readiness后绑定；`captureOwnedIdentityDatabaseV1` 直接调用其真实正常停止，并核launch配置对应本源数据库、进程退出与零旧连接。源APP改为NOLOGIN；capture仍用自有维护连接读取完整事实和custom dump，前后事实一致后封装，最后源DB禁所有连接。
- pg_dump使用默认stdout，不传`--file=-`。完整数据库custom格式保留对象/所有权/ACL、全部用户表、序列、LOB等；角色属于PG全局对象，在两端单独创建/核验能力与无成员关系，不能假称包含在pg_dump内。
- 新格式 `IDMSIDB1` 用AES256GCM和独立随机key/IV，manifest与dump共同加密认证，绑定issuer/版本/源cluster/DB/role/代数与事实SHA。解封和上下文核验成功之前不创建目标库。
- `restoreOwnedIdentityDatabaseV1` 仅新库，APP保持NOLOGIN；pg_restore单事务/遇错停止/保留原所有权及ACL，使用已知本模块创建的可信源。启动前逐项比较事实，通过后才允许目标APP登录并记录代数2。目标产生新写入后，原捕获版本不能再次恢复到此handle。
- `assertOwnedIdentityAuthorityV1` 检查本handle、镜像外代数记录与两端实际围栏；旧source/epoch1拒绝。它是本层自有环境准入，**尚未接入原站运行准入，也不是跨进程持久控制器**。

## 比较范围与限制

比较用户schema、普通表/序列/索引、owner/ACL、有效列逻辑顺序/类型/默认值/约束、函数、默认权限、类型清单、全部表行排序SHA及行数、序列参数/当前位置、LOB OID/owner/ACL/内容SHA、DB编码/locale/ACL。逻辑恢复允许内部对象OID、历史删列的物理attnum改变；不把内部编号变化当作丢列。保留有效列顺序，不能重命名或忽略实际列/数据变化。已删除列的历史物理字节不属于逻辑备份。

当前拒绝外部扩展（默认plpgsql除外）、foreign server、非支持relation kind、RLS、event trigger、自定义非支持类型、DB级角色设置和非默认表空间等范围。事实提取为开发规模的内存读取（dump128MiB、manifest4MiB、每LOB32MiB上限），尚无大库流式/PITR/HA保证。未穷尽所有数据库对象/ACL变体及运行环境供应链；完整pg_dump范围与本层实际源内容的事实核对不等于通用任意数据库认证。

会话验证使用后台直授登录，比较持久realm/user UUID、JWKS、refresh、新token中的当前角色和范围、logout/disabled拒绝，并证明原access JWT仍可验签。**旧JWT能验签不等于当前权限仍有效；不承诺即时撤销离线JWT。** 未覆盖外部LDAP/SAML、短暂认证流程/cache/action tokens、所有offline会话或浏览器PKCE跨迁移。

## 执行与清理

运行 `node scripts/verify-identity-database-migration-v1.mjs` 一次产生唯一run目录，包含两端引用、加密包/key、事实、停止证明与结果。超时只继续观察同一handle，不能因观察超时启动第二轮。私密work/.local、账号、token、key及dump不得提交或交付给普通用户。

清理只按自有cluster身份/DB与role OID核验、零连接后DROP，不FORCE，不杀其他客户端。`verify-identity-database-migration-cleanup-v1.mjs <nonce>...` 独立只读核PG clean shutdown、原JVM退休、已记录数据库目录消失和成功轮加密包/源目标事实一致。

生产接入前仍需持久维护权/互斥/崩溃接管、独立身份权威记录与原业务恢复准入联动、原实例接管/整站切换、Linux运行与外部secret/provider见证。新模块不会因本层通过自动切换原身份库。

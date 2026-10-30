# 原SQL事务的有界映射读取缓存

本组件是完整捕获V2的内部读取层，不是SOURCE或当前用户授权能力。创建只接受真实pg.Client和当前RR/serializable事务、精确root描述及私有工作目录；使用pg.Client.prototype.query固定查询，不接受回调、SQL、actor或approved。实际PG帧含系统/数据库/后台启动/txid/原会话身份，创建前后与完成前一致；监听原连接ReadyForQuery及socket关闭，事务结束或SQL错误永久废止，ROLLBACK后重开事务或savepoint恢复不能重新激活缓存。

固定bytea[]批查询每批最多128节点元数据；私有SQLite队列和索引存当前根可达节点、值长度和内容。值每批最多64项、8MiB；沿用状态值1MiB、2百万节点、1GiB叶值引用上限。节点完整性、缺项/重复、每个实际值的长度/哈希/解析、所有branch和完整root/叶覆盖重建；数据不能被复制JSON当作原句柄。缓存仅当前原客户端，没有新增PG后台；空根同样绑定原事务。

所有文件在目标PGDATA以外的原私有工作目录独占创建，4MiB SQLite页缓存、磁盘临时存储及4GiB页上限。成功和失败均关闭索引、移除自身监听并只删除自己的原单链接文件；不提交/回滚调用方PG事务或关闭调用方连接。外层完整捕获仍须保留全部SQL receipts/关系/原writer证明、head/profile前后核验及原授权期限。

新实际隔离PG组件构造256叶含大值与重复值的真实树，独立重建后序字节摘要并核全部内容与原根，证明数量和字节分组真正发生。覆盖空根、假/复制/关闭句柄、原COMMIT+新BEGIN、SQL错误后savepoint恢复、原socket关闭、缺节点/值、值漂移/重复行、结构合法但branch错误、PGDATA拒绝、纯请求边界及全部私有文件/连接正常退休。该组件不代表完整SOURCE、当前用户、完整捕获V2或Native20整合接受。

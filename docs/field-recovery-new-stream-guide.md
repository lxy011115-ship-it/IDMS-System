# 正式恢复激活后的新采集流

本链路在独立测试数据库中使用真实 OPC UA/MQTT 协议和生产主服务、SDK、SQLite 队列及正式边缘进程，接续[正式激活命令](field-activation-operation-guide.md)。设备和 broker 是本机自有测试端，不代表外部物理设备验收。原正式 4010 系统保持旧功能，不在此流程部署新 FIELD。

源端先以真实初始化生成的 ACTIVE 身份运行生产 HTTP 与 mTLS 接收服务。设备的两个实际读数经机器签发、只读加密 OPC UA、HMAC 事件、WAL/FULL SQLite、mTLS 和 PostgreSQL 提交产生两点、两回执和真实签名 ACK。测试故意不向旧队列应用这两个 ACK，保留旧 pending、payload、digest 和认证 metadata，供跨恢复隔离检查。

机器授权 URL 在源首次读取前写成真实回环地址；恢复目标复用同一端口。后续直接读取 edge 配置，不能在 SDK 中用参数覆盖占位端口。设备、点表、profile、证书、请求键、事件键、签发键和各配置保持。请求键还与受认证归档中的源注册观察摘要逐字节核对，源与新目标数据库绑定确实不同。

原生 begin 把源置为 RESTORING 后，源机器接口拒绝并且不返回签名，接收连接退役并释放所有权；源核心和 SDK 关闭后才冻结/归档。完整备份、源不可连接、新目标恢复、实际 OIDC/Flowable 独立 plan-v2 审批和正式 activate 依次执行，不能手工写 ACTIVE 文件或 SQL 阶段。

恢复库存在真实 Flowable 工单时，新核心仍须使用对应的真实工作流客户端配置，关闭工作流配置不能作为启动替代。引擎数据库在本测试中持续存活；该链路不是引擎数据库备份恢复证明。源政策由自有领域 fixture 形成，恢复计划的独立审批使用真实 OIDC 和 Flowable，两种证据范围分别说明。

源和目标使用正常 edge-directory 的 `stream-<binding SHA>.sqlite` 文件。新恢复身份改变 registry 与流绑定，新队列从自己的规范文件开始；旧文件保留。旧历史事件和 ACK 签名仍能核验，但旧 ACK 不能清新队列，新授权也不能清旧队列。旧排队事件在任何旧回执查询前因当前恢复 registry 不同被拒绝，旧点和旧回执不重写。完整恢复耗时超过旧短租约期限时，旧 lease 的签名拒绝原因会如实报告 EXPIRED，并同时核对响应所指的新 registry，不伪造时钟延长租约。

新 SDK 流在实际 COMMIT 前暂停：外部连接看不到新点/回执，也没有业务 ACK，broker PUBACK 不清 pending。实际 COMMIT 后的签名 STORED ACK 才可清除确切事件。另一次实际点提交完成后丢弃应用结果，队列保留 pending；重发原 payload 后恢复原 receipt/audit ID，不重复点、回执、审计、根或序列分配。该点接收故障与正式激活事务的线缆级 COMMIT 回复截断分别报告。

随后关闭 SDK/SQLite/MQTT 客户端，保持新核心，用正式命令 `node services/field/index.ts --config <同一edge配置路径> --once` 在同一新规范队列继续 sequence。它必须保留旧 stream，正常读取并提交后再退出；不能另建相同 stream 的 sequence=1 队列。停止核心后再启动该 CLI 应有界失败且不修改旧/新队列。这项离线启动拒绝不代替最终独立证据离线重算 CLI。

测试数据口径：源归档两点/两回执，SDK 新流再两点，正式边缘进程续两点，目标总六点/六回执；新队列四条已确认，旧队列仍两条待确认。旧点/回执的原始 SQL 行、旧队列 metadata/payload/digest、实际材料文件保持。之后正式 recover 仍须在当前授权与当前完整流程校验后接受正常新数据，返回原固定激活回执。

最终冻结证据、独立离线重算工具、受控正式部署和完整商业范围继续单独验收；本机测试进程运行与生产 commissioning 分开记录。

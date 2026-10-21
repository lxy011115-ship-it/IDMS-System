# 预测任务控制进度

2026-10-21：准备后的取消、独立人工 retry 和持久接受关闭已接到真实身份、独立 HTTP/worker。当前源仍为 WIP，原运行站点和云端未升级；预测界面、实际浏览器 PKCE/手机和完整商业待办未完成。

最终当前证据 `work/predictive-controls-auth-v4-20261021/39de2c649948/verification.json`，21 项。包括实际 HTTP 接受后丢回复/按原 UUID 恢复并关闭，真实 held POST 晚到被拒，真实预测响应 held 后准备分析取消与迟到丢弃；直接实际 SQL/SDK 准备复核夹具经产品 worker 取消，旧 writer 受 fence，原告警不变、自己的 intent 释放。

实际 Flowable 创建后错回执进入 HUMAN_REVIEW。自审 retry、审核未完成时原人抢先授权、已退出的审核引用均拒绝。独立审核保持原 context、完整计划与原 Flowable 信封，事务审计和原生回执后置 WAITING_AUTH；原人新 grant 恢复同一条真实引擎命令。发送开始后的 close 只返回 recoveryRequired，不报告取消。两个独立产品 CLI 在一个真实规则响应被 held 时执行各自 SQL 作业。

SQL 反例验证无取消回执/审计的伪造 CANCELLED delta、改变原 context 或缺独立复核回执的 retry delta 均整笔回滚。不可变 retry_requests 台账覆盖每个控制 UUID，多个失效审核之后旧决定也不能重新排队；root 复制模式下修改被 ALWAYS 触发器拒绝。重放已完成的同决定不增加业务根或审计。

当前 SQL 协议重新验证 `d50194871837`，12 项，含真实 COMMIT 丢回复和 32 秒主线程阻塞续租；当前 SDK 内核 `0ee8088f3c28`，13 项，含批准/签名事实、真实规则 CLI/Flowable、创建后的原维修完整闭环。新控制 SQL 已列入 SQL 验证输入 pins。最终输入快照和当前 SHA 一致。

早期控制轮次 `5e98f2ee809f` 和 `bbb1f9aa1116` 均通过并清理，但分别缺后续 SQL 反例/双 CLI、或不可变决定台账，不当作最终源证明。一轮 verifier 编辑产生语法错误，解析阶段即失败、未创建新 QA 资源，修正后新 nonce 执行；未改旧执行快照。

575 项单元测试最终标准 npm test 全通过，新增 RETRY 密文用途/控制 UUID 隔离测试；类型/build 268 构件与 16 组历史只读保值检查通过。初次并行实服务期间全量单测 574/575，失败为既有依赖 20ms 墙钟窗口的 WeightedCache 测试。未修改冻结源码；全部服务 QA 终态后单独 8/8 与标准完整 575/575 通过，保留初次失败日志，不将负载关联当成已证明的根因。

新控制三轮 18DB/66角色、本轮 SQL 两轮 10DB/34角色、SDK 一轮 6DB/22角色，合计34DB/122角色清理。只读累计检查认证/控制48DB/176角色、SQL35DB/119角色、SDK23DB/87角色名称/OID无库存，8个实际专属 realm均404；自有 Node/Java终态及10私密配置删除，无FORCE/未知backend终止。原R2最新控制状态ACTIVE/open/gate RELEASED，九服务/PG保持运行。

接口见 `predictive-controls-v4-guide.md`。下一步继续当前设备/告警/证据列表详情、统一站点预测页面、真实PKCE/三宽度/未知接受与草稿恢复体验；队列密钥启动 witness/完整轮换、旧宿主/outbox迁移、容量/全站切换/恢复/现场/商用待办继续。

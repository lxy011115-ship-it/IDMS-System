# 正式应用管理器的现场 SITE 槽位

延续已授权的完整方案 A 与现场网关接入设计。本阶段把真实 SITE 子进程接到应用管理器，后续平台依赖控制器仍须登记 broker、edge，并完成正式现场恢复/激活批准、治理 V6、历史迁移、消费入口与完整验收。不得把本阶段视为系统完成。

采用独立 V2 manifest / V2 registry / V3 manager，保留旧版本历史证据。manifest 显式 field.enabled；启用时必须准确指向唯一 SITE 槽位。两种状态均使用支持早期持有的新 SITE 子进程；包装层 enabled 与 manifest 必须一致，在创建子进程及读取现场附加材料前检查。后台四类组件仍按原冷恢复入口启动，不能把接 SITE 等同于治理 V6 切换。

管理器实际 fork 后立即保存句柄与 close 观察，再接受绑定 owner、component、challenge、PID、配置和 manifest 摘要的 CREATED。写入 START_AUTHORIZED 后才发送 START；停止与启动竞争时只发送原 STOP。未到 CREATED 也保留并排空自己的真实句柄，不凭 PID 接管，不通过信号或全局 kill。

正常关闭不以 CLOSED/EXIT 计数代替资源证明。SITE 实际 close 后重新读取独占结果文件，核对绑定、IPC 回执、同一 requestId 及真实退出。逐层验证 SITE HTTP 为零、gateway 关闭、host 连接创建数等于退役数、platform 的 owner/issuer/receiver 均关闭且密钥清空、MQTT 连接与重连均退役。启动取消允许尚未创建的资源为空；曾就绪的 enabled SITE 必须具备全部资源证明。登记 RETIRED 后才允许停止后台成员。无法证明 SITE 退役时保留其余依赖运行，给出失败，禁止继续停止 PG。

结果摘要只含绑定、摘要和退役计数；原结果保留在私有 registry 目录。正常 group 仍要求全部组件曾就绪、原请求 CLOSED、实际 code=0/signal=null 及 SITE 退役证明。取消与异常退役单独标注。相同 group requestId 返回同一个关闭过程，换 requestId 拒绝。

验证覆盖严格 manifest、现场开关错配在附加读取前拒绝、真实 fork START 门禁/启动取消/配置失败/无关 owner 隔离、完整资源证明缺项/伪造计数/仍持锁/未清密钥/MQTT残留拒绝、registry 禁止先停后台及缺退役事实。最终仍须 enabled SITE 原生整链、平台实际 broker/edge 接线与双平台完整验收；不能用边界测试替代。

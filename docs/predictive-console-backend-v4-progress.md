# 预测产品后台接线进度

2026-10-21：新 HTTP/独立 worker CLI 已接真实 Keycloak 与加密共享会话。当前源仍为 WIP，不升级原运行站点，不当作完整产品界面或商业验收。

当前证据：`work/predictive-console-auth-v4-20261021/e97d05bebe73/verification.json`，10 项真实检查；更新后的 SQL 协议 `work/predictive-console-pg-v4-20261020/a7765d7bf349/verification.json`，12 项检查（包括实际 COMMIT 丢回复、Flowable 和主线程阻塞 32 秒下的独立续租）。输入快照和结束时逐 SHA 一致。认证夹具使用实际 Keycloak direct grant、服务器验签和有认证审计的共享会话创建；本阶段没有浏览器 PKCE。

实测 HTTP 只持 QI/READER；真实 CSRF/Origin、隐藏站点拒绝入队、伪造企业/身份、外人作业不可读、同 UUID 复用与内容冲突。撤分析权限后 worker WAITING_AUTH，明确重授后使用原命令分析。真实预测器响应被暂扣后撤销真实角色，响应后不发布；新 SQL 修订推动 SDK 新修订后恢复。独立真实身份审核，经原外部发送边界在实际 Flowable 创建一条命令，HTTP 验证原生回执/审计才显示已完成。退出使其他进程中的旧引用失效，同人新会话可恢复。

新 Worker 专用 `reject_unprepared_v4` 持久拒绝尚无 SDK 准备的语义错误；真实 SQL 验证拒绝空 status，且不能把已有 SDK 事实的命令标为未准备拒绝。六种错误私密配置均在 READY 前失败，不输出凭据。

失败历史保留：e5045f0f8247 撤销全部读取权限会正确撤销旧会话，夹具错误期待旧会话直接重授；7144c405788a 的用户属性 PUT 丢失必填 profile，直接授权被拒。夹具改为保留只读角色和完整 profile。8678b6b0e6a9、c4506bed594e 是较早源码阶段通过，不能代替最终 e97d05bebe73 的当前源证明。五轮均已终态和精确清理。

canonical 574 项单元测试、类型检查、268 构件 build、16 组历史只读保值检查通过。新认证 QA 累计 30 个 DB/110 个角色，名称/OID 实际库存为零；SQL QA 累计 25 个 DB/85 个角色也核验无遗留，后者包括之前历史环境。独立 Node/Java 子进程终态、各专属 realm 删除、当前轮 10 个私密配置删除，无 FORCE 或未知 backend 终止。原恢复 owner 仍 ACTIVE、九个原服务继续运行，原物理 PG 和云端不变。

接口和边界见 `predictive-console-backend-v4-guide.md`。后续继续已有 SDK 的安全取消、独立人工 retry、产品未知接受关闭与竞争验证、设备/告警/证据读取、统一站点页面、真实 PKCE 与三宽度。新旧作业宿主绑定迁移、旧未解决 workflow outbox、全局容量/密钥轮换/恢复/现场及商用待办继续。

后续任务控制已推进，准备后的取消、独立人工 retry 与持久关闭详见 [控制接口说明](predictive-controls-v4-guide.md) 和 [当前验证进度](predictive-controls-v4-progress.md)。原有本阶段局限应按此后续阶段更新读取；预测界面/浏览器验收仍待完成。

# 旧预测作业接管 B：后台阶段进展

新 fresh SQL r2、独立接管 HTTP/worker CLI 和原人授权适配器已实现。原 worker、旧 SQL 安装器和当前运行系统保持原样；没有切换原统一站点或云端。完整方案 A 目标仍 ACTIVE，当前属于实际进展。

最终证据为 `work/predictive-legacy-adoption-v4-20261021/6a7a25d1f798/verification.json`：10 组真实检查，26 个当前源码 SHA 一致。执行的是固定 SHA 的五个历史 SDK 模块、实际 PostgreSQL、真实 Keycloak 验签与有审计的加密共享会话、独立产品 HTTP/worker/规则 CLI，以及独立 Flowable 引擎。登录夹具通过实际 direct grant 后由服务端验证并创建共享会话；本阶段未验证浏览器 PKCE 或接管按钮。

- 真实规则回执破坏进入 HUMAN，真实撤分析权限进入 WAITING；接管后前者保留人工错误，仍需异人独立 retry 和原人明确重授，后者沿原命令继续。
- 外部 Flowable 已实际创建但成功回复被丢弃；接管保留原计划、actor、command/entity/requestDigest 信封，恢复后引擎仍一条创建命令。终态 SDK 历史保持原值，SQL 完成状态须核原生回执与审计；安全原生取消可恢复历史。
- 实际原生接管 COMMIT 成功回复被丢弃后按收据恢复。接受后原生重授导致候选变旧时不写宿主；无效操作全回滚；新明确接管保持原 SQL 身份并 fence 旧租约，旧控制显示已被替代。HTTP 接受后注销使 worker 引用失效，新会话须再次明确接管。跨 actor/header/租户、CSRF、过期 hash 与 QI 直接权限均拒绝；不可变台账在 replica 模式仍受 ALWAYS guard 保护。

早期安装尝试 `6b901c2b1d0c` 因新 PL/pgSQL CASE 条件缺括号而失败，创建的 5 库/21 角色已精确清理。修正后 `87275a1f345a` 为较早后台版本通过，之后补候选变化、租约替换、注销和被替代控制检查，再以最终新 nonce 通过。各次原始证据和输入快照均保留，早期通过不充当最终 SHA 的证明。

本阶段累计 17 库/65 角色按名称与 OID 只读查验全不存在；两独立测试 realm 实际 404，自有 Node/Java 进程终态、5 份最终私密 runtime 文件删除，迁移计划和源码输入私密保留。没有 FORCE 删除或终止未知 backend。canonical 596/596 回归、构建及 server/predictor 类型通过，16 历史只读保值检查通过；既有统一站点 r2、R5 与读取迁移 A 的当前源 SHA 保持。

当前 WIP 尚未正式双份冻结。浏览器接管控件与身份切换恢复、未证实安全的已取消外部创建人工对账流程、C workflow outbox、整站受控切换和后续商业待办继续。原运行 owner/core 和九服务未启停；idms.xin 保持备案前准备范围，DNS/公开 HTTPS/代理/安全组未改。本阶段不证明现场预测有效性、全图性能、恢复 HA 或商业验收。

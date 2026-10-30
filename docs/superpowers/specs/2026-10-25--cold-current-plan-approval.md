# 持久恢复计划的独立人工批准

状态（2026-10-25）：独立批准日志、当前身份观察和V13协调器已实现，99项核心回归及单独WAL/INSERT后锚点中止/2048容量/新版计数器边界已通过。父版本C39跨平台74单位、16Java、43完整集成及独立V3通过。当前51项Windows真实服务集成任务已取得首个审核身份请求、两类原协调器写故障、实际提交后应用回复丢弃及新鲜同ID重试的中间证据；整轮、独立复核、当前版本Linux、HTTP/UI和最终启用尚未集成验收。容量使用合成身份，不宣称2048次真实人工认证；中间结果和设计文件不替代完整验收。沿用完整方案 A，不改变现场、迁移、正式启用或最终图文视频交付目标。

## 目标和现有依据

当前 `cold-review-plan-journal-v1.mjs` 将提交计划及完整贡献者沿革写入原控制 SQLite。新 `runtime-cold-review-prepare-v13.mjs` 内部完成原持有会话、完整原源、7 库事实、完整根、当前身份和两次真实工作流捕获后才调用该模块及独立批准日志。计划中观察到一个独立审核人，明确批准须走单独批准入口。历史读取不代表当前身份认证。

本阶段增加审核人对确切当前计划的明确批准。批准不是源数据更正，不修改原 SOURCE_V3、fullFacts、原 details.review、首次 result 或计划正文。正式注册、角色权限开放和 ACTIVE 是后续最终事务的一部分，不能因批准记录存在而自动开启。

## 路线选择

继续使用旧业务图中的恢复审批器会依赖旧 public.business_state 和旧运行身份，不能直接认证当前控制 SQLite 的持有会话和完整来源。将批准直接写回计划正文则破坏已签名提交历史，并混淆计划作者与审核动作。

采用独立的批准日志：复用原协调器和真实身份验证能力，以新日志和独立签名 anchor 记录批准动作。只在当前真实控制事务中追加；最终启用仍须核对计划、全部批准、当前权限及正式材料，并处理最终 SQL 提交结果。

## 请求与人工意图

新增协调器入口只接受原 session、recoveryId、approvalId、tenantId、expectedPlanSha256、明确的 APPROVE 决策及该审核人的当前用户访问令牌。新准备器构造配置可增加 approvalConfigurations；其中每企业一项配置仅由可信部署侧提供，批准时完整覆盖当前计划企业并与计划中 externalConfigSha256 精确绑定。没有这些构造配置时批准入口拒绝，其他已有入口维持原合同。请求不能提供配置对象或私密路径。拒绝 caller actor 对象、approved 标志、任意 SQL、业务快照和授权回调。

每次请求只记录一个企业的一位审核人的动作；其他企业批准不能由本次动作代填。审核人必须与该企业当前计划中指定的 observedIndependentReviewerId 一致，并排除完整签名祖先导出的所有实际作者和声明共同作者。更换审核人必须形成新计划提交，不能对旧计划临时替换身份。HTTP/UI 后续必须使用审核人自己的认证会话与 CSRF 保护，并展示当前计划摘要及实际证据供其明确确认；后台观察到有效令牌不能自动生成批准动作。

## 完整验证与时间边界

先在原控制写锁和独立身份 authority 锁内读取完整签名计划及全部祖先，要求请求精确指向未过期的当前 head。原持有会话及完整 7 库、全部原 SQL 事实、完整根和原持有工作流校验保持，不能只重算计划 JSON。

审核人令牌由真实 OIDC 校验，并读取当前账户、角色、租户、范围、notBefore 和活动 sid。贡献者来自已认证的当前计划原观察文件及完整沿革；重新检查每个已认证贡献者的当前权限与原 session，不要求或伪造贡献者的新令牌。沿用 `revalidateRecoveryPlanAuthor` 的权限重查含义，明确区分它与新的用户认证。

两侧读取的当前审核人与全部贡献者、原持有工作流和 authority 必须保持相同，并满足原 30 秒最终观察窗口；完整源读取可在该短窗口之前完成，但其会话与维护锁在整个动作期间保持。提交前再核对 head、原意图、authority 和观察有效期。任何超限、撤权、登出、证据漂移、工作流变化或源事实不一致均拒绝写入，不延长既有窗口或计划期限。

批准观察采用精确 schema：format、原 control/source/fullFacts/recovery/intent/credential 绑定、planSha256、tenantId、externalConfigSha256、原持有 readerLeaseId、fullFactsCheckSha256、reviewConsistencySha256、两次真实 workflowCaptures、原计划观察文件引用及摘要、reviewer、全部 contributorRechecks、beforeActorsSha256、afterActorsSha256、capturedFrom、capturedAt、expiresAt、windowMarker、验证含义标志及 sha256。审核人字段保留当前认证的原 actor 格式；贡献者重查保留原认证记录摘要和实际当前权限记录，按 actorId 完整排序。标志区分 reviewerCurrentlyAuthenticated=true、recordedContributorsPermissionRechecked=true、contributorsFreshlyAuthenticated=false、formalFieldActivationGranted=false。原始令牌不保存。观察规范 JSON 存为同 case 私密新文件，日志引用完整摘要和时间；路径、类型、链接数、大小及重读字节一致性必须验证。

## 持久化与幂等

专用批准表和 details 下独立签名 anchor 同原控制事务原子追加。正文及 anchor 使用不同 HMAC 域，绑定原 control/source/fullFacts/recovery/intent/credential、计划 UUID/完整 head SHA、企业、审核人、原观察身份摘要、当前批准观察摘要、明确决策及时间。完整日志每次认证，schema/index/trigger 精确检查，不能通过删除旧批准或孤立 anchor 隐去历史。

沿用最多 64 个计划、每计划最多 32 企业的完整范围，批准记录最多 2048 条且每条最多 128 KiB；同一计划企业只能成功批准一次。新计划不删除旧批准，但旧批准对新 head 不生效。有效期不超过原计划剩余期限，不因重试延长。

同一 approvalId、相同计划/企业/审核人/决策可在完成新的权限及完整状态核对后返回原结果，不增加记录或改变时间。相同 ID 的不同输入、同企业第二个批准 ID、非当前 head 或过期计划拒绝。调用者不能借旧幂等结果绕过当前权限。模块不自行 COMMIT；协调器提交失败不得留下日志或 anchor 的一半。结果未知时按同一 ID 重开控制库认证真实持久结果，不直接报业务失败或生成新 ID。

## 输出与后续启用

区分单企业历史批准、当前计划全部企业批准及本次当前认证观察。历史状态接口只报告已认证的签名历史，不声称调用时仍具有当前权限。全计划批准必须覆盖当前 head 的完整企业集合，不能按筛选结果宣称全部通过。

本阶段即使批准完成，businessWritesEnabled、formalFieldActivationGranted 和 fullGoalComplete 仍为 false。最终注册和 ACTIVE 需要独立的完整材料/依赖登记、当前权限和批准重验、唯一审计、原最终 SQL 事务及提交结果不明恢复。只读准备状态不冒充已恢复的正式业务运行。

## 必须取得的证据

1. 真实 SQLite 的行与 anchor 原子提交/回滚、新进程重开、完整祖先和全部批准重验、2048 完整边界与超限拒绝；单位夹具不能声称真实身份验证。
2. 不同企业、任一历史贡献者、自审、机器身份、错误指定审核人、伪 session、调用者批准对象、缺失/改变原证据、schema/anchor/签名篡改均拒绝。
3. 真实 Keycloak 和原持有 Flowable 完整案例：各企业独立审核人明确批准当前计划、同 ID 新鲜重试、提交者/共同作者/审核人撤权或登出、窗口期间实际撤权、工作流变化与过期拒绝。
4. 新计划生效后旧批准不计入，新 head 要求完整企业新批准；作者变换后的全部贡献者仍排除在审核人之外。
5. 原控制事务前故障实际回滚；实际持久提交后丢应用回复、新进程按原 ID 恢复且唯一追加。应用层回复故障与 TCP COMMIT 回复故障须分别标明证据，不混称。
6. 独立核验从原证据重建每次成功动作的完整根、工作流、当前身份观察、贡献者重查、签名沿革与原 source/intent 未改。Windows 和确切新 Git 提交的 Linux 原生及清理均通过后才能发布本阶段通过声明。

## 自查和未完成边界

设计明确区分计划提交、人工批准和最终启用；每个企业的批准身份和明确意图不可由后台补齐。可信配置固定在新准备器构造配置中，批准观察采用上述精确 schema。最终启用仍须新增绑定实际部署材料和目标权限的明确计划、完整独立批准及最终提交验证，当前日志的只读恢复批准不会直接开放运行。正式启用及完整交付仍待实现和验收；已实现的批准模块以当前Windows整轮、独立及确切Linux证据为准。当前C39及C40全部冻结输入不修改，后续使用新文件与新案例。

# 工单用料计划与备件计算依据

更新：2026-10-30。依据已批准的[方案B](superpowers/specs/2026-10-30--spares-demand-and-explainable-insights.md)。本阶段是服务端与专用迁移工具；页面接入、完整业务加密恢复和实际企业切换仍按[实施计划](superpowers/plans/2026-10-30--spares-demand-and-explainable-insights.md)继续。源码提交不等于主站已启用新能力。

## 业务口径

用料计划记录工单、备件、同工厂仓库、计划总量、需用日期与依据。服务端从当前规范工单和批准设备推导归属；同一工单/备件/仓库只有一条计划。现有备件管理职责或当前工单领退料职责维护计划，其他岗位只读，不增加身份服务角色或改变账号授权。

剩余需求为进行中计划的 `max(0, 计划总量－该工单/备件/仓库的实际净领用)`。关闭工单或关闭/取消计划计0；已关闭计划需人工恢复。安装已包含在原领用中，不能再扣一次。超计划显示超出量，不阻止原有合法领用。计划不预留库存。

拟补充量为 `max(0, 安全库存＋当前可见剩余计划－完整共享现存量－已登记下单未收量)`。现存4、安全3、剩余计划8、登记未收2，则现存对计划缺口为4，拟补充量为5。不同单位不相加。未收量仅计 ORDERED/PART_RECEIVED 采购行的 `max(0, 订购量－净收货量)`；退供减少净收货，关闭、草稿、退回及仅批准未下单不计，批准未下单另作提示。采购需求日期不是供应商承诺，接口不生成到货日期。停用档案不产生新建议；没有可见进行中计划时明确提示需求未登记。

更换统计只使用同位置、备件和设备的真实登记。单条数量等于当前位置装机用量才构成全量样本，同一天去重；部分/分次登记单独计数并排除。至少4个不同日期、3个间隔后展示中位数和最短间隔。手填最近日期不作为间隔样本，另标是否有对应原记录。早于当前配置周期只提示核对，不作寿命、故障或质量结论。

## 查询接口

沿用企业会话、`spares:read` 和当前事务。路径均在 `/api/v1/spares/` 下，仅支持 GET；默认30条、最多100条，以 `cursor` 翻页。重复、未知、越界参数拒绝。

| 路径 | 参数 | 返回与用途 |
| --- | --- | --- |
| `material-plans` | 必填 `workOrderId`；可选 `limit`、`cursor` | 工单计划、净领用/剩余/超计划、标签和当前可操作状态；批准设备缺失时不开放创建 |
| `stock-insight` | 必填 `partId`、`warehouseId`；可选 `basis=plans/purchases`、`limit`、`cursor` | 全范围计算输入与结果，以及 `basis.items/hasMore/nextCursor`；切换依据种类从首页重读 |
| `replacement-insight` | 必填 `linkId`；可选 `limit`、`cursor` | 全范围登记统计与原始依据页；不足样本不返回中位数或最短值 |

响应包含 publicRevision、revision、businessDay。双版本、身份、范围、引用、依据种类及页长绑定签名游标；变化返回409。统计覆盖全部当前可见数据，不是本页求和。完整共享库存保留隐藏工单的合法流水，但其需求、名称和操作者不会输出。

`features.materialPlans/insights` 表示数据库能力；未迁移时新接口返回 `ready:false`，现有库存和采购继续使用，页面须据能力显示入口。marker、实际分区或必要唯一索引不完整时明确拒绝查询和写入。查询使用既有同连接 RR、完整审计、取消/超时及资源预算。

## 计划命令

沿用 `POST /api/v1/spares/commands`、现有幂等请求头及 `{action,input}`：create 接收 partId、warehouseId、workOrderId、quantity、needDate、reason；edit 接收 id、expectedVersion、quantity、needDate、reason；close/cancel/reopen 接收 id、expectedVersion、reason。动作名均以 `material-plan.` 开头。不接收归属、状态或其他任意字段。数量沿用档案精度；版本冲突409，未知提交保留原请求/原键核对，不改写实际领退与更换。

## 专用迁移与恢复

迁移不在普通启动中执行。在完成完整业务、加密恢复和页面验证后，先用既有独立备份角色与私密密钥创建格式2完整档案，再对单一企业运行专用入口。以下占位符须替换为实际私密配置，不提交密钥或档案。

```sh
node scripts/backup-tenant.mjs --tenant TENANT --key-file PRIVATE_KEY_FILE
node scripts/setup-spares-insights.mjs --tenant TENANT --backup PRIVATE_ARCHIVE --key-file PRIVATE_KEY_FILE
```

默认使用 `.local/postgres-migration.json` 与 `.local/postgres-business.json`，可用 `--config`、`--business-config` 指定。验证专用用途、服务器/企业绑定、认证后的格式2备份及来源数据库后才连接，解密dump不落盘。事务按公共业务共享锁→库存状态写锁顺序，比对当前规范业务检查及备件连续性锚与备份；有变化要求新备份。

专用迁移角色切换到既有owner，添加分区/索引及 capacity=2、insights=1，只给应用/备份角色增加新分区 SELECT，不增加应用 DDL 或历史 UPDATE/DELETE/TRUNCATE。前后连续性锚必须一致。支持完整能力幂等重跑，拒绝半装或降级marker；提交确认丢失时报告未知，先核对数据库再处理。

新能力事件使用独立v2哈希域，旧事件字节不变，旧核验器不能无声忽略新需求。回退须核对兼容性，恢复使用隔离目标，不改低marker或覆盖当前企业库。

## 验证边界

`npm run spares:insights:verify` 使用随机拥有QA库；加 `-- --growth` 验证超过10000实体、20000事件后的同一业务。覆盖迁移回滚/权限、示例计算、部分收货/退供/关闭、超计划/恢复、隐藏需求与共享库存、双版本分页、精度/停用、0/1/3/4/5日期与半日中位数、旧历史损坏和缺失必要索引拒绝。

QA历史由真实领域规则生成并由隔离owner导入，公共业务投影仍为合成的，不能冒充企业录入、完整规范业务证明、认证档案实际恢复或浏览器/岗位验收。当前企业库不写测试业务、不调整账号；本阶段不启用公网或解除生产门禁。

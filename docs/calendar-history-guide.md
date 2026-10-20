# 日历生效安排与审批截止复核

日历配置声明某设备在一个有限范围内的 RUN/STOP 区间。`calendar-schedule` 独立声明何时使用哪个已批准日历。两者分别创建草稿、提交冻结、由未参与该版本的授权人员终审；每台设备各有一个编码族。仅发布配置不会隐式产生生效安排。

在企业模板页已发布或历史日历卡片点击“编排生效时间”，核对生成的完整 JSON 后保存。默认提供一小时后的未来切换，须在引用日历的声明范围内。未来范围不足时先创建新日历；历史安排可以复制已有安排或在草稿 JSON 中明确编写。用途筛选可单独查看日历配置与生效安排。

```json
{
  "schemaVersion": 1,
  "minPlatformVersion": "0.1.0",
  "purpose": "calendar-schedule",
  "modules": ["equipment", "quality"],
  "policy": {"finalApproval": "INDEPENDENT_HUMAN", "deviceAccess": "READ_ONLY"},
  "calendarSchedule": {
    "deviceCode": "DEVICE-A",
    "changeIntent": "INITIAL",
    "changeReason": "按生产审批确定首次安排",
    "entries": [
      {
        "id": "activate-a",
        "effectiveFrom": "2026-10-17T08:00:00+08:00",
        "calendarRef": {
          "templateId": "已批准日历ID",
          "templateKey": "operation-calendar-a",
          "version": "1.0.0",
          "contentDigest": "替换为真实64位小写SHA256"
        },
        "reason": "生产班次切换依据"
      },
      {
        "id": "unassign",
        "effectiveFrom": "2026-10-18T08:00:00+08:00",
        "calendarRef": null,
        "reason": "后续计划尚未确定，明确保持未知"
      }
    ]
  }
}
```

示例中的 ID 和摘要是占位内容，不能直接提交。条目最多128项，ID唯一，带明确偏移的真实时间严格递增。引用须精确匹配本企业、本设备已独立批准的 `PUBLISHED` 或 `RETIRED` 日历；生效起点必须在该日历声明范围内。引用日历必须在安排批准前已批准，不能引用草稿、未来才批准的版本或其他设备。显式 `null` 表示未分配；缺省引用无效。日历到期后仍未覆盖的时段是未知，不自动延长计划。

- `INITIAL`：首个发布安排。允许明确声明过去的首次安排；此前审批截止时间查不到它。
- `PROSPECTIVE`：以后发布的未来调整。批准时刻之前及该时刻已经生效的条目必须完整保留，包括ID、依据、时间和引用；可修改未来尾部。
- `RETROSPECTIVE_CORRECTION`：明确历史修订及变更依据。新版本可修订过去的生效安排，旧版仍可按原审批截止时间查询。回滚也创建更高版本，不改写原发布内容。

覆盖接口 `/api/v1/data-management/coverage` 与 `/api/v1/telemetry/coverage` 保留默认 `planMode=CURRENT`，仍使用当前已发布日历配置和原响应结构。选择 `planMode=EFFECTIVE` 后按安排生效时间切片，可传 `knownAt` 限定批准记录的截止时刻；留空参数须省略，默认取查询时刻。拒绝未来截止、无偏移时间、重复/未知参数、空模式及 CURRENT 携带 knownAt。

```text
/api/v1/telemetry/coverage?deviceCode=DEVICE-A&planMode=EFFECTIVE&from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z&knownAt=2026-10-17T12%3A00%3A00Z
```

安排版本按其持久 `TEMPLATE_APPROVED.businessTime <= knownAt` 选择最高版本。同一毫秒用语义版本排序；后续发布记录时间倒退会拒绝。这个时间是持久审批事件的逻辑时间，不能解释为数据库物理提交瞬间或可信授时证明。所有查询先检查当前身份和当前设备范围，旧安排不恢复已收回权限。

EFFECTIVE 响应使用 `ruleVersion=effective-calendar-coverage-1.0.0`，增加 `timeline`：审批截止、选择版本、摘要、治理事件、变更意图、截止前版本目录，以及每段的时间、依据、缺失原因和精确日历来源。`items` 为测点与分段的组合，各项含 `segmentIndex/segmentFrom/segmentTo/entryId/entryReason/calendarSource`。每段左闭右开，实际记录不跨段重复；槽仍锚定该日历冻结的 RUN 起点，边界相交的部分槽按段各计一个。因此不跨版本平均百分比或把各段槽位当作同一个槽。按段分页，最多2048测点/分段组合，超过返回422并要求缩小筛选。

没有截止前批准安排为 `SCHEDULE_UNDECLARED`，尚未到首个生效时刻为 `NO_EFFECTIVE_ENTRY`，明确空引用为 `CALENDAR_UNASSIGNED`。这些状态保留实际记录并返回未知覆盖率；STOP无计划槽，覆盖率不设为100%。历史日历、原批准快照、独立批准身份、退役依据或数量/身份无法核验时返回安全503，不输出部分统计。采集复核在同一个只读 REPEATABLE READ 事务内验证业务根、当前定义、安排历史和完整记录统计，历史模板正文逐行读取，沿用资源预算与取消排空。

**本次重放范围严格为 `CALENDAR_ONLY`。** `definitionMode=CURRENT_APPROVED`，`dataMode=CURRENT_AUTHORIZED_RECORDS`。当前批准测点定义、有效更正后的记录与当前接入点表继续参与计算。更正数据或修改定义/点表后，同一 knownAt 的覆盖结果可能改变；这不是完整的当时报告复现。完整定义/记录/接入配置的历史重放及冻结报告仍是后续待办。现场投产、设备健康和预测模型准确性也不由覆盖率证明。

本阶段没有新增表、迁移、依赖或修改历史摘要公式；安排与治理事件存于现有模板和审计表。原客户数据库保持只读验证，不写入合成业务。完整商业方案A继续推进，当前仍是本地开发里程碑。

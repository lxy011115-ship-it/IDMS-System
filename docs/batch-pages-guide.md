# 批次输入与批准历史分页

后续[批内双流证明](cold-inputs-guide.md)已移除bindings-only中的整批rows/validRows驻留，保留原完整canonical及全部来源；本页数字和实现说明属于对应历史阶段。

后续[逐批冷证明](cold-imports-guide.md)已将启动/独立SQL的输入和事实改为逐批/逐行；旧完整只读消费者明确收集同一证明的真实对象，原canonical/全部来源和完整写模型保持。以下样本属于对应历史阶段。

批次抽屉提供“冻结输入”和“批准时记录”两个标签，每页50条，可翻至所有输入。原先仅前20条的详情preview保持兼容，审核人员通过新页查看完整行、原始来源行、有效行选择和错误证据；JSON详情包含完整嵌套值。输入中的profile_values/类型引用也可查看。翻页和切换标签保留本批审批意见/人工复核依据；切换批次、身份或关闭后清理，迟到响应不回填。

## 接口与含义

- `GET /api/v1/data-imports/{batchId}/rows?page=1&pageSize=50&snapshotDigest=...`：冻结的标准化输入，包含`inputOrdinal/sourceRow/validOrdinal/validation/value/errors`。输入位置不等同数据库ordinal；来源行是既有冻结CSV/XLSX物理行或JSON索引+2，允许嵌入换行造成间隙。原始表头和文件内容仍通过原文件及映射证据追溯。
- `GET /api/v1/data-imports/{batchId}/records?...`：本批批准时的不可变记录。包括root事实或更正事实、批准版本、前批次/来源行/记录摘要。后续更正不会改变历史页；当前有效值仍通过数据中心/记录历史查询。未批准和仅重复无新增批次可以为0。

新页严格只接受page/pageSize/snapshotDigest，不接受重复键、非规范正整数或未知参数。默认50、上限100、page最多1000000；输入摘要为可选64位小写hex。整批无权404，不泄漏隐藏计数或摘要；已授权但pin不符409 `BATCH_INPUT_CHANGED`。source/页绑定不一致503 `BATCH_READ_INTEGRITY`。每次请求重新认证及核对当前范围。

`VALIDATED`仅表示选入有效输入，不表示已经批准；`ERRORS`关联该物理来源行的错误；`NOT_SELECTED`表示没选入有效行，不猜测所有遗留输入的重复原因。批准仍使用冻结摘要、expectedVersion和独立人工责任；浏览页不会执行批准。

## PostgreSQL读取与权限

新页以及原列表/详情通过独立SQL调度和REPEATABLE READ READ ONLY读取。先完成既有完整企业canonical、文件、审计、治理锚和全部事实/更正投影证明，再执行批次范围和目标页。指纹仍绑定全部关系的MVCC来源；未验证、篡改、取消均失败关闭。页数据/计数与证明处于同RR，pin不是完整性替代物。

有范围的身份先构建当前批准DEVICE最小范围索引，再逐行检查全部目标输入和更正before。严格保留旧边界：列表可使用旧设备line兜底；详情及新页沿用getBatch规则，不使用该兜底，不扩大授权。DEVICE使用历史输入的site/line/device；其他类型按当前有效设备。任一行超范围时整批隐藏，不能因本页刚好可见而局部放行；更正前后都须在范围内。Node保留既有String/null/缺失和原值语义，驱动每次最多额外留1行。数据库条件全部参数化。

原列表的筛选/宽松分页和详情DTO完全保留：preview前20，errors前100，不附原件。新SQL返回明确摘要和页DTO，不把截断数组伪装成完整BatchBody。文件Demo另用实际完整数组适配，verificationScope明确为FILE_DEMO_ARRAY_MODEL，明确不具备PG按需读取特征。

## 验证与限制

复现：`npm test`、`npm run build`、`npm run batch:pages:verify`；原站点只读核对用`npm run batch:pages:live:verify`。专项在命名隔离QA库和真实OIDC/Chrome中执行，原企业不写合成业务。最终证据见outputs/batch-pages-verification.json及当前chat独立快照。

本批实际减少温态列表/详情/分页对全企业输入事实对象图的依赖。首次或指纹失效时的完整证明、其他旧GET轻工作区仍包含全部输入/有效行副本/事实；更正元数据及设备范围索引可以增长，范围仍扫描整批，输入页的排序/row_number/错误扫描在服务器执行。完整写preimage/Workspace/wire、同步CPU、原件目标bytea及长期物理容量未由分页解决。逻辑账本不是RSS硬限或生产SLA。完整商业方案A继续，生产门禁关闭。

## 本阶段验收记录（2026-10-16）

196项单元、86个运行文件及全部脚本/类型和20组原回归通过。真实100设备/20k测点、17文件22181112字节：426页逐项匹配完整模型的20275条输入/20209条历史事实；温态任务峰值415442逻辑字节，完整/轻图重建0次、缓存0条、返回页最多100条。有范围的整批授权流最大额外driver行1，包含旧列表line兜底而详情/新页拒绝的真实OIDC用例。

12类查询结果故障、同RR快照与后续无revision变化的篡改拒绝、取消恢复、独立终审/同键、审批意见与人工依据跨页保留、关闭后迟到响应、403后清理、历史版本/XSS和移动端均通过。原4010已部署，同SID/CSRF/旧JSON及加密游标连续；停机全payload/逐表/历史迁移、六原文件14513字节、8条原输入/5条批准事实、CSV、角色/归档及前后29表业务隔离恢复保持。没有新DDL；专用升级基线拒绝覆盖。完整目标继续。

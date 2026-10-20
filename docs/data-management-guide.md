# 多类型设备数据管理指南

更新日期：2026-10-15。当前为本机开发验证版，不是生产验收。

## 入口与顺序

启动 `启动IDMS.cmd`，访问 http://127.0.0.1:4010/?view=data-center 。真实登录账户位于受限的 `.local/本机登录账户.txt`，不得公开或打包。先批准设备台账，再批准测点定义，最后上传并批准测点记录；每一步都需要另一名有权限的终审人员，上传者叠加角色也不能自审。

支持七类上传：DEVICE设备、POINT_DEFINITION测点定义、MEASUREMENT测点记录，以及PRODUCTION生产、STATE_INTERVAL状态区间、MAINTENANCE维修、QUALITY质量。界面支持CSV/XLSX，保留JSON上传接口；无需先运行预测。

企业CSV/XLSX现可选择独立发布的字段映射，支持中文表头、标准化预览、原表头/行号及映射版本冻结。JSON仍用标准字段。见`import-field-mapping-guide.md`；映射不执行值/单位转换；已批准数据使用显式更正批次，不覆盖历史。

## 设备台账

原必填字段保持兼容：`source_record_id,device_code,device_name,site_code,line_code`。

可选增加：`equipment_type,brand,model,serial_number,criticality`。关键度为LOW/MEDIUM/HIGH/CRITICAL；旧设备没有类型时显示未分类，不补造属性。设备编码在本企业内唯一，不能通过另一来源重新创建。

上传页“下载空白模板”和“下载填写样例”在DEVICE类型下提供扩展字段；“使用样例上传”保留旧工程样例兼容。样例不是企业事实，须替换内容，只在隔离沙箱演示。参考 `upload-templates/devices-extended.csv`。

真实OIDC当前按企业隔离，可登记不同工厂/产线；这不是工厂/设备细粒度授权。文件Demo仍限定FACTORY-01/LINE-01。

## 企业测点定义

字段：`source_record_id,device_code,tag_code,tag_name,unit,min_value,max_value,expected_interval_seconds`。最后一项可选，为1至31536000的整数秒，不代表实时采集调度已启用。

测点编码为小写字母开头，仅小写字母、数字和下划线，最长64字符，禁止保留名称。单位最长32字符；物理范围须为有限数且下限小于上限。每企业/设备/测点只能有一项有效定义，批准时重查并发冲突；已批准字典通过独立终审的更正批次生成新版本；不能使现有测点记录失效。

同一测点编码可以分别在泵组使用MPa、在空压机使用bar；记录必须使用本设备定义的单位，当前不自动转换单位。物理范围只是输入有效性边界，不是健康、报警或安全阈值。参考 `upload-templates/point-definitions.csv`。

旧工程测点 `vibration_rms`、`bearing_temperature`、`motor_current_std` 保持兼容。其内置单位和范围不能更改，以免改变工程预测器的语义；其他设备应定义独立测点编码。使用旧工程字典会标记LEGACY_ENGINEERING_SAMPLE，不冒充企业批准定义。

## 测点记录与追溯

沿用字段：`source_record_id,device_code,tag_code,measured_at,value,unit,quality`。采样时间须含时区；质量为GOOD/BAD/UNCERTAIN。同设备同测点同采样时间禁止多来源重复计入。设备和自定义测点必须先批准，整批存在校验错误不得入库。

设备数据中心按类型、工厂、关键词筛选资产；按设备、测点、时间和质量查询记录。分页默认50、最多100。可查看单位、采样时间、质量、原批准批次/物理行号、快照摘要和定义批次来源。定义列表按设备/测点筛选，最多展示100项。

GOOD仅是数据质量，不代表设备健康；BAD也不等于设备故障。手动历史上传不代表实时在线；无数据不表示正常。数据中心不执行预测或自动放行。

## 数据质量与范围

当前质量工作台入口为`?view=data-quality`，读取有效上传版本并提供规则依据及失败批次定位。报表和批次文件按设备范围执行；混合批次原文件只允许整批可见的身份访问。参见[data-quality-and-scope-guide.md](data-quality-and-scope-guide.md)。采集实时质量和生产安全仍需后续验收。

## 已批准记录更正与版本历史

七类数据可从设备数据中心或已提交批次行查看历史并创建更正，也可在文件上传时选择更正原批次。理由、旧值和旧摘要冻结，独立批准后切换有效版本，原记录保留；批准包可下载全部行的前后差异。并发更正整批冲突，不新增同ID事实或重复计数。参见[更正与历史指南](record-corrections-guide.md)。当前测点定义显示有效版本，旧定义从版本历史追溯。

## 按筛选导出CSV（2026-10-16）

设备档案及测点记录各有“按已应用条件导出 CSV”按钮，导出当前成功查询条件下的完整结果，不限于当前50行页面。表单未查询的编辑、查询失败后的筛选不会替换上次成功查询条件。PG平台采用同一已验证只读快照内双遍游标，取消10,000行上限；每次128行、64KiB输出块并逐块核对，文件仍受默认256MiB及准备/发送期限约束。OIDC浏览器由原生下载接收，无需完整Blob；超限422并提示缩小筛选，不静默截断。文件Demo和显式数组适配仍最多10,000行。空结果输出表头。详见csv-stream-guide.md。

沿用read权限，按企业和可信身份中的工厂/产线/设备范围过滤；本批没有独立导出授权开关。SQL汇总、设备类型/工厂选项、测点定义也使用同一范围，修复了早先汇总/选项未过滤及定义查询参数序号问题。其他业务页面的数据范围仍需逐模块验收。

导出为UTF-8 BOM/CRLF CSV，双引号、逗号及多行文本正确转义。文本公式前缀增加单引号以阻止表格执行，原数值保留为数值。包含来源系统/记录ID、原批准批次、物理行号及快照摘要；测点另保留定义来源。该文件用于分析和追溯，包含额外列及安全文本处理，不能直接当上传模板回传。

接口：`GET /api/v1/data-management/assets/export?q=&equipmentType=&siteCode=`、`GET /api/v1/data-management/measurements/export?deviceCode=&tagCode=&quality=&from=&to=`。筛选沿用查询校验，禁止分页、未知或重复参数。真实身份由现有会话或Bearer校验，不接受参数切换企业。响应no-store、nosniff。SQL在同一REPEATABLE READ只读事务中计数/提取，超限不提取数据。本批不涉及历史数据或数据库模式迁移。

验证命令：`npm run data:export:verify`。使用一次性PostgreSQL集群和合成数据，不依赖本机55432或Keycloak；验证SQL/文件查询及CSV逐字段一致、范围/空权限、分页以上完整导出、来源、未批准排除、Excel回读、危险文本、浏览器下载、失败筛选及320/390手机。测试后停止并清理自身资源，核对原本机快照及运行配置摘要。真实Keycloak全链回归本轮未运行，不能据此宣称完成生产验收。

## 保留接口

读接口使用真实会话或Bearer，租户来自经验证的身份声明，不能用参数切换企业：

```text
GET /api/v1/data-management/overview?q=&equipmentType=&siteCode=&page=1&pageSize=50
GET /api/v1/data-management/measurements?deviceCode=&tagCode=&quality=&from=&to=&page=1&pageSize=50
GET /api/v1/data-import-templates/DEVICE?profile=extended&sample=1
GET /api/v1/data-import-templates/POINT_DEFINITION
POST /api/v1/data-imports
POST /api/v1/data-imports/records
POST /api/v1/data-imports/{batchId}/approval
```

筛选时间使用带时区的ISO时间，URL编码通过URLSearchParams生成，避免加号被当成空格。写请求须带幂等键和关联ID，浏览器会话还须同源Origin/CSRF；不得提交租户、审批、身份等保留字段。服务端控制AI模式，真实平台是本地模型SHADOW抽样，未配置转人工，不能绕过终审。详细契约见 `api/data-upload.openapi.json`。

## 验证与后续

`npm run data:verify`使用临时数据库/账号验证多设备上传、独立审批、SQL失败回滚、跨企业隔离、重启、XSS和手机页面，结束清理自身QA资源。`npm run data:live:verify`只读验证4010，核对原业务摘要，不造企业业务数据。

PostgreSQL数据中心现已使用设备/测点/记录领域表及参数化SQL分页，来源行与批准事务同步；旧快照可无损回填。文件Demo保留同契约实现。详见 `data-sql-storage-guide.md`。

设备类型继承、冻结质量参数及设备范围已开发验证；v3实体分表/双核心事务见normalized-state-guide.md。尚未完成：映射值转换、批量定义运维、生产全链权限/容量、专项领域SQL/TimescaleDB、对象存储/容量归档、跨服务灾备、安全性能和真实企业验收。当前写入/审批仍依赖聚合快照，SQL查询小样本成功不能作为大规模设备数据性能证明。预测/RUL和自动中审必须另有现场数据和评测门槛，不因数据管理上线而视为完成。

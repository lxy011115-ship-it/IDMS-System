# IDMS 本机版本交付与依赖核查

日期：2026-10-15。范围：当前 Node.js 项目、已安装 npm 依赖、打包脚本及既有演示 ZIP。本报告不是法律意见、完整 SBOM、安全渗透测试或商用验收。

## 本轮结论

现有开发网站保持运行；不发布新的商用包。旧演示包因版本过期并包含本机上传快照，已从公开 outputs 位置移入受限 `.local/quarantine/` 保留，内容未修改、未删除。不能将已移动旧包重新作为宣传素材分发。

## 当前验证证据

| 检查 | 本轮结果 | 证明边界 |
|---|---|---|
| npm test | 60 通过、0 失败 | 当前单元测试；不是重新执行全部集成测试 |
| npm run build | 40 项运行文件及脚本语法检查、TypeScript 通过 | 不是生产构建/安装包可运行证明 |
| npm audit --omit=dev --json | exit 0，已知漏洞 0 | npm 审计服务在本次查询时未报告；不覆盖未知漏洞、Java、操作系统、独立运行时或模型 |
| 锁定 npm 生产依赖 | 389 个包路径条目 | 含重复版本/嵌套位置；不是 389 个独立软件产品，也不等同实际发布清单 |
| 4010 health | UP、OIDC、企业独立 PostgreSQL、SQL 数据查询、已发布字段映射 | 有限健康检查，不等于全部下游与生产验收 |

本轮 `package-lock.json` SHA-256：`11666ce194677c5e2bf3920dca9f975357f7fdf4d5cba1bc2ffeba88155b966c`。代码或锁文件变化后须重新扫描。

直接生产依赖当前解析为 exceljs 4.4.0、jose 6.2.12、mqtt 5.16.1、node-opcua 2.187.8、pg 8.23.1，其已安装包声明均为 MIT。这里没有逐一审阅全部 389 个包的每份许可文件，不能据此声称全量合规。

## 许可证声明与补证

包元数据的原始声明计数：MIT 354、BSD-3-Clause 4、Unlicense 2、缺失 4、MIT/X11 1、Apache-2.0 3、ISC 17、MIT OR GPL-3.0-or-later 1、MIT AND Zlib 1、0BSD 2。元数据缺失不直接等于无授权，需要检查对应发布版本内的证据。

| 依赖 | 已核实的版本内证据 | 后续义务/缺口 |
|---|---|---|
| buffers 0.1.1 | package.json 无 license；已安装 README 无许可证声明，未发现许可文本 | 保持待核实；从该版本可信发布源补证，或评估替代，不能自行补成 MIT |
| chainsaw 0.1.0 | package.json 声明 MIT/X11 | 尚未找到该包完整版权/许可文本，发布前补齐可信版本证据与通知 |
| dequeue 1.0.5 | LICENSE 包含完整二条款 BSD 与版权信息 | 交付时保留对应许可和版权通知 |
| humanize 0.0.9 | LICENSE 含完整 MIT 授权与版权信息 | 交付时保留原许可通知 |
| precond 0.2.3 | README 明确 MIT，index.js/lib 源码头部有作者与 MIT 声明 | 不是未知授权，但完整 MIT 许可文本尚需可信补证并纳入交付通知 |
| jszip 3.10.2 | LICENSE.markdown 明确可选择 MIT 或 GPLv3，附 MIT 全文 | 可以按 MIT 路径评审，不可仅因 OR GPL 就认定整个 IDMS 必须开源；发布时保留适用许可与版权 |
| pako 1.0.11 | 根 LICENSE 为 MIT，lib/zlib 源文件含 Zlib 通知 | AND 要求两类义务均满足，不可只保留根 MIT 并剥离源文件通知 |

依赖来源已用 `npm explain buffers dequeue humanize precond --omit=dev` 核实：buffers 经 exceljs → unzipper → binary 引入；其余分别由 node-opcua 地址空间/诊断/安全通道依赖引入。不修改 node_modules 伪造许可或直接删除间接依赖。

Ollama、qwen3 模型、PostgreSQL、Temurin、Keycloak、Mosquitto、Maven、Flowable 与完整 Java 传递依赖未在本轮做全量分发许可审阅。已有模型许可记录见 `ai-gateway-guide.md`，不能代替整套交付物合规审查。

## 旧 ZIP 的处置证据

- 原位置：`outputs/IDMS手动上传演示包.zip`；文件时间为 2026-10-14，大小 12,597,698 字节。
- 内容目录检查：6,534 项，其中非 node_modules 项 87 个；无最新 `server/import-mapping.ts` 和 `docs/scheme-a-development-status.md`，不能表示当前平台版本。
- 内含 `.demo-data/local/imports.json`，为 version-1 本机快照：6 批次、5 条记录、9 条请求、18 条审计；6 批均含内嵌原文件。未输出记录、文件内容、账号或任何凭据。
- 目前不能证明上述快照全为可公开合成数据。检查到快照不等于已证实真实客户泄露，但足以阻止继续分发。
- 已移动至 `.local/quarantine/IDMS手动上传演示包_20261014_禁止分发.zip`，受限目录与文件 ACL 仅授予当前 Windows 用户。未覆盖目标、未删除快照、未改动实际业务数据库。
- 移动前后 SHA-256 均为 `f26919080f80bfc2c5bebceaa43f3b6160f7ee767623eb20e2b8e0561f256466`；原 outputs ZIP 已不存在。文件可由本机当前用户恢复，但在明确脱敏和审批前不得分发。
- 本次仅控制本机副本，不能证明以前没有分享过或能召回既有副本。

## 当前打包脚本的剩余缺口

`scripts/package-demo.mjs` 当前排除 `.local` 与 `.demo-data`，但这不能修复此前生成的旧 ZIP，也不是已完成新版包验收。尚需处理：

1. 脚本直接 import archiver，但 package.json 未将它声明为直接依赖，目前仅借助 exceljs 的间接依赖解析，打包工具边界不稳定。
2. 通过顶层目录名黑名单复制 node_modules，不是按已解析生产依赖图生成清单；可能夹带 TypeScript、类型定义或其他开发依赖。
3. 整体复制 services 目录，未明确控制 Java target/嵌入式 JAR 等构建产物；未来构建后的内容与许可证范围可能发生变化。
4. 尚无发布包级的版本/源码摘要、完整组件与许可清单、私密路径扫描、原文件内容边界检查及干净环境安装/启动验证。
5. `outputs/demo-preview`、样例和说明也必须单独确认都是可公开合成内容，不能仅因路径叫 demo 就默认安全。

本轮不执行打包、不替换依赖、不自动修复 npm 版本、不改动正在运行的服务，也不把程序能运行当作第三方许可已清算。

## 下一步与发布门槛

先按已提交的数据库分权方案完成评审及实施；并在发布工程中补齐上述许可证证据、完整组件/NOTICE、明确的生产文件白名单、秘密扫描、合成演示数据与独立干净安装验证。新包只能在这些证据成立后称为经过对应范围验证的开发/演示包；商用发布仍须关闭 `scheme-a-development-status.md` 的全部适用阻断项。

本次具体进展为发现并隔离不合适的历史交付物、补充已验证依赖证据和交付缺口；不是整个方案 A 完成。数据库分权设计尚待用户确认，不因本报告而获得已实施状态。

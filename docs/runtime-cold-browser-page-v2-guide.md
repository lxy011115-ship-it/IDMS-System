# 冷恢复后的页面存储采集验证

本轮 Windows 验证使用公开批准模板资料，在独立业务 PostgreSQL、身份 PostgreSQL、Keycloak 和 Flowable 上完成 23 项原生检查，进程正常退出。它补齐了真实页面写入、换号和退出后的三阶段存储证据。它不是原私有资料 Linux 验收、云端切换或完整商业生产验收；最终用户图文手册和演示视频仍需基于最终验收版本制作。

## 已取得的证据

- 真实 S256 登录、七类页面写入、独立预测复核、维修提交和独立关闭；工单最终为 CLOSED 第 5 版，真实工作流为 SYNCED。
- 最小角色和实际分页：站点 19 台/2 页、产线 18 台/2 页、指定设备 1 台/1 页、交集为空 0 台/1 页。后台独立只读清单用于比对，浏览器仍须实际访问所有页面。
- 同一个实际会话的刷新间隔 30034 毫秒；四模块共享退出；另有 5 个明确标为后台合成会话的访问负例。
- 三阶段均实际采到 2 个 localStorage 键、3 个 sessionStorage 键和 7 个有界恢复编号；写入后、换号后、退出后的 Cookie 数量分别为 1、1、0。换号后没有其他账号的可见恢复作业。未发现已知凭据、未知键、IndexedDB 或 CacheStorage。
- 独立清理复核确认 3 个 PostgreSQL 目录干净离线、7 个恢复目标业务库目录移除、身份正常停止、4 个工作流正常关闭及 20 个连接池关闭回调、JDBC 连接归零、17 个 Node 子进程退役，并重新核验全部三份页面回执、快照和 Cookie 元数据。

第一次 `CHECK operator` 在访问统一首页前因缺少站点上下文失败；补读首页后通过。该失败保留在原始报告中。本轮共有 16 个顺序文件命令，其中 15 个成功；不能声称零失败命令。18 个实际检查记录覆盖 14 类必需检查，包含四个范围账号各自的角色检查。

## 启动与操作

```text
node scripts/verify-runtime-cold-browser-page-v2.mjs <PG-bin> <JDK-home> <Maven-home> <Keycloak-source> <source-bundle> <external-SHA256> [offline-Maven-repository]
```

沿用既有受控冷恢复前置条件。等待 `CONTROLLED_COLD_BROWSER_READY`，新案例写入 `work/runtime-cold-browser-page-v2-20261023/<nonce>`。每次都是新的隔离案例，不重启历史中断案例。账号、配置、原始存储和身份信息只留在本机私有目录。

登录后读取统一首页及四模块，再发送角色核验命令；分析员与只读及范围账号的对账上下文应为 403。正向写链完成后执行 `CHECK_WRITES`。

测试 HTTP 包装层仅为维修页附加可见采集按钮和同源脚本，原产品源文件及页面资源保持原字节。采集属于明确的测试页面仪器，不能把该页面称为未附加采集功能的生产页面。它只读存储和当前可见作业编号，不写入或清空浏览器存储，不放宽原 CSP。

1. 操作者在“我的作业”中看到独立终审命令后，选择“写入后”并点击“采集本页存储”。
2. 通过正常退出和登录切换到只读或最小范围账号，打开“我的作业”的空视图，选择“换号后”采集。
3. 正常退出并实际读取四模块的未登录状态，发送 `CHECK logout`，在维修未登录页选择“退出后”采集。

浏览器适配器 `capturePageSnapshot` 接收已经就绪的 CUA 标签和其受支持的 CDP 能力，执行正常页面选择和点击，然后独立读取九条已知同源 RP 路径的 Cookie 元数据。Cookie 值先哈希再保存；不会过滤额外 Cookie，也不会触碰身份提供者或其他应用的 Cookie。

服务器顺序保存 `browser-page-storage-000N.private.json`；适配器保存 `browser-storage-000N.capture.json` 和旧严格格式的 `browser-storage-000N.private.json`。每次通过 `CHECK_STORAGE active 1`、`CHECK_STORAGE switched 2`、`CHECK_STORAGE logout 3` 检查。原 `verifyColdBrowserStorageSnapshotV1` 的白名单、凭据拒绝、未知存储拒绝、Cookie 和可见编号规则保持不变。新校验还绑定实际页面回执、请求会话摘要、浏览器适配器 SHA 和 30 秒内的 Cookie 观察时间。

全部检查通过后发送 `COMPLETE`，等待原生最终报告、正常终态和下列独立检查，再关闭测试标签：

```text
node scripts/verify-runtime-cold-browser-page-cleanup-v2.mjs <nonce>
```

页面或浏览器能力不可用时保留未完成。不得伪造空数据、注入服务端测试会话、重写既有快照或删除断言。原始报告和私有快照不进入 Git。

本轮执行固定 444 份源，原 556 份受管文件和旧 429 份执行源保持。原有本机与 Git 的两个包声明差异继续明确保留，未在本次归一化；本轮不把 Windows 执行证明扩写为私有原资料的 Linux 证明。新增 CI 仅覆盖 28 项采集 HTTP/来源绑定/严格存储与范围单元测试，不能替代真实浏览器运行。

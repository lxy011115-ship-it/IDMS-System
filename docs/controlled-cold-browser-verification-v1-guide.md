# 冷恢复后的真实浏览器验证

此验证在独立的业务 PostgreSQL、身份 PostgreSQL、Keycloak 和 Flowable 上运行。先执行完整受控冷恢复协议的 15 项检查，再保留本轮恢复目标，供真实浏览器通过登录页操作。不会连接原站点、修改原 JAR、切换云端或发布域名。

## 启动

```text
node scripts/verify-runtime-controlled-cold-browser-v1.mjs <PG-bin> <JDK-home> <Maven-home> <Keycloak-source> <source-bundle> <external-SHA256> [offline-Maven-repository]
```

数据来源沿用 `runtime-cold-portable-guide.md`：公开样例和私有原资料有不同的 profile。私有资料包、账号、运行配置、SQL 密码、HTTP 观察记录和恢复证据必须留在本机私有工作目录，不得上传公开仓库。

等待 `CONTROLLED_COLD_BROWSER_READY`。新目录为 `work/runtime-controlled-cold-browser-v1-20261022/<nonce>`；`browser-ready.json` 提供本轮 URL、所有者和进程号；`browser-users.private.json` 只包含本轮合成账号。必须使用真实登录表单，禁止把后端测试会话注入浏览器。

标准输入支持以下命令：

| 命令 | 必须实际取得的证据 |
| --- | --- |
| `STATUS` | 当前已完成的检查和命令失败数 |
| `CHECK operator` | S256 登录、真实回调、HttpOnly / SameSite=Lax Cookie、四个模块实际读取 |
| `CHECK analyst` | 同上；前三模块读取，对账 context 必须 403，审批权限保持撤销 |
| `CHECK reader` | 同上；只含 read 权限，前三模块读取，对账 context 必须 403 |
| `CHECK refresh` | 同一个浏览器会话至少间隔 20 秒，实际 session 响应的有效期延长 |
| `CHECK logout` | 带 CSRF 的真实退出成功，之后四个模块页面均取得未登录 session 响应 |
| `API_NEGATIVES` | 后端另建并最终删除的合成会话：跨企业 403、冒用操作者 403、未登录 401、他人授权不可见 404、只读业务动作 403 |
| `COMPLETE` | 所有上述检查存在后写入证明，再由外层正常关闭全部本轮资源 |
| `ABORT` | 本轮失败，并执行外层正常清理 |

业务角色边界以后台权限为准。分析员和只读账号没有 `predictive:approve`，因此不能读取对账工作区。不能为满足测试而增授角色，也不能把 403 改写为成功读取。

## 会话可恢复的命令方式

在启动前设置 `IDMS_CONTROLLED_COLD_BROWSER_FILE_COMMANDS=1`，改用本轮私有目录里的顺序文件。文件命令有 45 分钟时限，不能控制其他部署或服务器；不要同时使用标准输入。

以独占创建方式写入 `browser-command-0001.json`：

```json
{"owner":"<browser-ready.json 的 owner>","sequence":1,"command":"STATUS"}
```

所有者、顺序和字段集合必须完全匹配。结果写入 `browser-result-0001.json`；确认结果后再写下一序号。不要覆盖或重复创建已消费文件。只支持上表的命令，没有任意代码、SQL、进程终止或 HTTP 认证绕过能力。

退出操作属于共享登录会话，不要求对账业务权限。对账页在退出前仅重新读取当前登录状态，并把当前 CSRF 交给原有退出接口；已有业务动作继续执行原权限、范围及版本核验。没有对账权限的用户也应当能够退出。

## 核验与限制

浏览器检查完成前，先保留各角色页面、权限提示和实际退出后的截图及 DOM。`CHECK logout` 成功后立即发送 `COMPLETE`，等待最终报告和正常清理完成，再关闭测试标签；这样关闭浏览器或对话切换不会抢先中断尚未写入的结论。以最终 `verification.json` 的 `passed` 和清理结果为准，不能把 READY、某个检查通过、进程消失或没有报错当成全套通过。

```text
node scripts/verify-runtime-controlled-cold-browser-cleanup-v1.mjs <nonce>
```

独立清理检查核验本轮 PostgreSQL 干净离线、正常关闭的工作流和身份进程、JDBC 连接清空、目标测试数据库目录移除及本轮 Node 子进程结束。进程中断后缺失最终证明的案例必须保留为中断，不能补造正常退出证明。

HTTP 观察器仅记录路径、状态、同源页面路径、身份及权限、S256 参数存在性、会话 Cookie 的 SHA256 和 Cookie 标志；不记录原始 Cookie、CSRF、令牌、密码或登录回调参数。观察器位于测试 HTTP 包装层，没有新增认证入口。

这些检查不等同于完整的页面写入验收、全部角色和站点/产线范围组合、浏览器原始存储审计、所有故障恢复矩阵、私有原资料 Linux 目标主机验收或正式生产上线。浏览器存储接口不可用时应明确保留该项未完成，不得以服务端观察记录替代。最终中文使用手册和演示视频仍须基于最终验收版本另行制作。

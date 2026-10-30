# 恢复后的治理、维修与预测后台

本入口用于新建、由当前管理进程持有句柄的后台进程。它接续已经完成准入的受控物理恢复，复用现有治理、维修和预测业务 worker。它不接管已有 PID，也不能代替完整生产组件登记或原站迁移验收。

## 启动条件

运行环境沿用受控恢复入口的 Node、PostgreSQL、独立身份权威和工作流要求。恢复控制记录必须为 ADMITTED，维护门及当前身份权威检查必须通过。业务、任务队列及身份审计账号必须属于捕获清单中的活动数据库和角色，并使用本次准入产生的密码。

将入口 JSON 与基础配置、权威配置、信任配置及密钥保存在受限的独立配置目录；不要提交 Git 或放入 PGDATA。入口文件只接受以下六个字段，路径相对于入口文件解析：

```json
{
  "format": 1,
  "purpose": "RUNTIME_COLD_BACKGROUND_V1",
  "kind": "MAINTENANCE",
  "baseRuntimeFile": "./maintenance-worker.json",
  "authorityRuntimeFile": "./identity-authority.json",
  "trustFile": "./cold-trust.json"
}
```

`kind` 可以为 `GOVERNANCE`、`MAINTENANCE` 或 `PREDICTIVE`。基础配置必须为 WORKER 模式，并引用同一独立 OIDC 权威。治理入口需要资料源；维修入口需要工作流传输；预测入口需要预测器、资料源与工作流传输。

```sh
node scripts/runtime-cold-background-worker-v1.mjs /private/config/entry.json
```

只有出现 `COLD_BACKGROUND_READY` 才表示本进程初始化成功。事件包含类别、租户和 PID；READY 不代表所有业务依赖长期健康。配置或权威检查失败时，本轮不继续领取任务，输出通用等待信息；应结合当前控制记录和依赖状态诊断。

## 配置与授权

加载器固定入口、基础配置、权威、信任、准入凭据及认证/任务密钥 JSON 的字节摘要，并在每轮执行和授权解析前重新检查。文件必须是普通文件，不能为符号链接或多硬链接，大小不超过 2 MiB。修改空白也会触发配置变更拒绝；需要更新时，先正常停止，再生成经过核验的新配置代次并启动新进程。

原有业务授权仍由既有 provider 处理。SESSION 引用还会经过恢复会话守卫；旧会话不会因复制数据库而获得新准入。BEARER 路径保留现有 JWT 和当前角色校验。本入口不证明跨主机克隆互斥，也不替代全部服务密钥轮换。

## 停止与重启

父进程通过 Node IPC 发送 `{ "type": "COLD_BACKGROUND_STOP" }`，或由部署管理器发送 SIGINT/SIGTERM。IPC 父连接断开也触发停止。不要用强杀代替正常排空。

停止时立即进入 closing 状态并输出 `COLD_BACKGROUND_DRAINING`。已开始的任务继续完成；维修命令完成后不再领取下一项流程任务。未完成的工作流意图保留在数据库中，由新进程继续处理。关闭完成后输出 `COLD_BACKGROUND_CLOSED`；管理进程还必须核对自己持有的子进程句柄正常退出，单独一行日志不是完整退出证明。

## 隔离验证

`scripts/verify-runtime-cold-background-v1.mjs` 在独立目录与独立数据库运行完整受控恢复，再启动两租户的治理、维修和预测进程。参数顺序与 portable R4 验证一致：PostgreSQL bin、JDK、Maven、Keycloak 原始分发目录、显式 source bundle、其 SHA256，最后可选离线 Maven 仓库。

该验证包含错误入口类别、HTTP 模式、过期密码、未登记角色拒绝；实际 HTTP 模板草稿创建；预测分析、另一用户审批和真实 Flowable 建单；维修领取；配置变更拒绝与新进程重启。它使用隔离测试专用后端会话，不是浏览器登录验证。

在途停止案例只对本案例恢复库的 `state_map_v1.head` 持 SHARE 表锁，观测实际 SQL 等锁且阻塞者正是本测试连接后发送 STOP，再释放自有事务锁。监控轮询会清除当前事务的活动快照，避免重复读取旧状态；其行为见 [PostgreSQL 16 监控文档](https://www.postgresql.org/docs/16/monitoring-stats.html)。核对当前命令提交、正常停止、流程意图仍待处理，随后启动新进程并核对同一意图同步成功。所有锁由本案例事务 finally 释放。

运行结束后，以报告中的 nonce 执行独立清理检查：

```sh
node scripts/verify-runtime-cold-background-cleanup-v1.mjs <nonce>
```

清理检查核对自有子进程、工作流和身份服务正常停止回执、连接池、数据库目录移除与 PostgreSQL clean shutdown。冻结的源目录、加密镜像和私有证据保留离线，不表示所有副本被删除。

GitHub 工作流 `Portable recovered background verification` 使用公开批准模板进行 Linux 隔离验证；该结果不能替代私有原件、目标云主机、完整浏览器或生产验收。实际通过情况以对应 commit 的 CI 终态及本地 verification.json 为准。

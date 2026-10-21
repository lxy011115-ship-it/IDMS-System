# R4 真实冷备恢复演练入口

本说明面向维护人员，介绍独立演练夹具。生产控制器、最终用户图文手册和视频仍在后续交付范围内。

## 运行前提

当前本地验证环境已准备 PostgreSQL 16、JDK21、Maven离线依赖、Keycloak及原业务只读样本。运行前检查原系统STATUS与原Java目标JAR，演练过程中保持它们不变。所有新数据库、角色和服务运行在新建私有集群中；原45432仅允许夹具读取原Acme的只读样本。

优先复用已有隔离构建的 `verification.json`，其中包含JAR路径与摘要；需要新构建时使用 `scripts/build-workflow-cancel-reservation-v1.mjs` 的隔离目录路径，不能运行 `workflow:setup` 覆盖原运行的target。

```powershell
node scripts/verify-r4-cold-recovery-v1.mjs <隔离构建的verification.json路径>
```

不传参数时使用当前已有的已验证构建路径。此入口依赖本地准备环境，并非裸Git仓库的一键生产部署。

每次生成 `work/r4-cold-recovery-v1-20261022/<nonce>`，包含新source/restored PGDATA、私密运行配置、围栏意图、PG生命周期事件、加密镜像与独立key、真实状态和最终verification。PG端口从当前Windows动态端口范围之外的空闲测试端口中选择，源关闭后目标继续使用同一端口。动态端口范围在当前主机实际查询为49152–65535；若迁移到其他环境，重新确认端口策略。

## 观察和清理

运行记录会逐步打印已通过的实际检查。迁移与目录校验可能耗时，查询现有进程/句柄确认其状态；观察超时不表示测试终止，不据此另起一轮。发生错误时保留失败证据，等待本次句柄终态和自有资源清理后修正。

```powershell
node scripts/verify-r4-cold-cleanup-v1.mjs <nonce> [更多nonce]
```

清理核验仅只读检查所选生成目录的集群标识、正常关闭、历史终态事实、当前无PG运行标记、专属realm已404及配置目录对应的Node/Java进程。它不删除目录、不终止任何进程。私密PGDATA、镜像与keys故意保留供离线审计；不要把它称为数据库文件已删除。

## 恢复断言

本夹具会真实准备并恢复两租户state_map和各队列、认证会话/审计、Flowable取消及reservation扩展。实际验证BLOCKED不建单、HELD仍持锁、已关闭动作和授权控制不被重开、授权代数与过期租约不回退、RELEASE_STARTED按原固定意图SYSTEM恢复，以及当前外部撤权不被旧镜像覆盖。

普通动作失去原会话后保持WAITING_AUTH，新明确授权才能继续；这与已持久开始释放的SYSTEM恢复条件分别验证。重新赋权后的审核人仍需新登录与新复核，原人需新会话确认。原native取消job/plan/receipt逐字核对，业务关联与工单不能重复。

围栏前后角色LOGIN及数据库connlimit变化会影响原目录摘要。夹具先比较冻结状态的结构，再恢复精确原权限并让原深见证加载，不为恢复重定catalog基线。

## 当前界限

`owned-cold-fence-v1-qa.mjs` 仅接受本次新建集群，记录意图并执行围栏和受限恢复演练；其准入参数由同一演练代码给出，不是可独立验证证据的生产准入协议。生产维护权、持久中断重入、源/目标操作互斥、失败补偿、完整运行环境和外部密钥见证仍待。

现有Flowable夹具停止方法只验证自有Java句柄退出，未证明Windows上的优雅关闭；PostgreSQL本身仍执行连接归零和正常smart stop。文件级冷备不代替在线备份、PITR或HA。浏览器PKCE/页面异常证据沿用先前单独的范围与限制，本演练使用后台direct grant，不宣称新增浏览器操作验收。

镜像、数据库文件、私密配置、会话原件、密钥和口令不得提交Git。仓库仅保存源码、规范、去秘密摘要与维护说明。

# 统一工作台 r2（WIP）

新修订组合现有数据与审计、预测与复核、维修工单。原 `site-console-v4` 和已冻结控制台不改；r2 从这些静态 HTML 生成自己的导航壳，领域规则仍由原 HTTP、QI 队列和独立 APP worker 执行。未把新修订切入原运行站点。

私密入口配置为 `format:2`、`purpose:SITE_CONSOLE_HTTP_R2`，仅包含 `baseSiteRuntimeFile` 与 `predictiveRuntimeFiles`。前者引用既有 format 1 站点配置，监听地址/端口及治理、维修成员均沿用该文件；后者必须为每一个已注册租户提供恰好一个预测 HTTP 运行配置。使用 `node scripts/site-console-v4-r2.mjs <private-file>` 启动，监听仍限本机回环。

预测成员启动时先拒绝 worker、服务配置及额外字段，再核对与对应治理成员完全一致的业务 READER/account/binding、OIDC 配置、认证部署、认证审计绑定和实际解析后的 authRuntime 文件路径。复用预测加载器核验 QI/READER 的数据库权限、SQL 目录和认证隔离后立即关闭临时认证实例；持续运行的会话状态、provider 与 sweep 仅由基站拥有。

首页和各工作区可相互导航。`/api/v4/site/context` 返回三个模块及重新核对的企业与维护阶段，治理与预测阶段不一致时拒绝就绪。预测私密请求的租户和身份头必须与当前服务器会话同时一致；仅由该身份选择对应已注册业务库，再进入预测领域本身的权限、设备范围和 CSRF 边界。公共页面不带私密配置，保持 no-store、CSP、nosniff 和禁止嵌入。

新宿主使用同一个认证入口；从任一模块退出会失效同源共享会话。认证生命周期仍由独立投递 worker 进入对应租户原生审计链，不在 HTTP 内持有业务 APP 或审计投递角色。治理、预测、维修 worker 的私密配置与生命周期继续独立。

运行新修订要求预测读取标记与索引已正确激活。旧已激活而缺新标记、来源摘要、基线、快照索引或宿主绑定的根不会静默升级。旧根/旧作业及 workflow outbox 迁移、原站点受控切换、队列密钥 witness/轮换、全图成本、容量/资源、恢复/HA/TLS/MFA/现场效度与许可、ICP 等工作不因组合入口而完成。

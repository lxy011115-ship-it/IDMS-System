# 持久身份权威与受保护入口

此能力把“当前使用哪份身份数据”放在业务PGDATA之外，并接入新的R4站点/对账worker入口。原运行实例和旧入口没有自动切换；它不等于完整生产恢复控制器。

## 状态与迁移顺序

控制器创建独立SQLite、Ed25519 private key及固定public-key trust。SQLite使用WAL、synchronous FULL和BEGIN IMMEDIATE；每条记录包含revision、epoch、operation、前序hash和签名。读取核完整链及最新head，没有进程内缓存的权威head。当前最多4096条记录，日志轮转还需受控设计。

首次登记是TRANSITION→ACTIVE。后续迁移必须先从ACTIVE进入**DRAINING**，再停止源、最后捕获/恢复数据库。DRAINING期间拒绝新入口；目标复制出的旧realm marker不能当作新权威。源DB/角色退役后核独立目标SQL身份，再进入TRANSITION；SQL和API同时证明新marker后才能ACTIVE。业务迁移不得绕开该顺序。

控制器用expected revision CAS互斥。未提交事务随进程退出回滚；已提交的DRAINING/TRANSITION保持不可运行。重入读取原operation/challenge继续，不随意创建新代数。ACTIVE提交后回复丢失，同operation的activation重试返回原head，不追加第二次发布。

## 实际身份绑定

发布控制器验证PG system ID、DB/role OID与owner；非首次登记还核旧源NOLOGIN/DB禁连/零旧客户端。控制器通过标准Keycloak管理接口写入realm属性中的authority UUID/epoch/随机challenge，然后直接核候选SQL的同realm属性，防止HTTP实际连错库。

业务运行时没有身份DB owner/维护密码或writer private key，只有固定trust及realm只读服务账户。它每次核最新签名ACTIVE记录、实际Keycloak realm UUID和三项marker，并在网络读取后再次核head未变。只看issuer/JWKS无法区别恢复旧库，marker用于识别这一状态。读者账户只授view-realm，不能更新realm。

SQLite/key/trust必须在所有业务镜像和身份dump之外，由独立部署配置固定路径和公钥。这里不宣称抵御整个控制目录及独立trust一起回滚，也不自动证明所有外部provider/secret/运行环境来源。

## 入口

- `site-console-authority-v1.mjs` 要求purpose为SITE_CONSOLE_AUTHORITY_V1的严格配置，包含baseRuntimeFile（R4配置）和authorityRuntimeFile。启动、HTTP请求以及共享普通授权resolve前后检查；没有自动回退旧R4的选项。
- `reconciliation-authority-worker-v1.mjs` 要求RECONCILIATION_AUTHORITY_V1包装配置。启动、领取任务前、普通授权resolve前后检查。固定RELEASE_STARTED恢复仍沿原已持久意图，不能扩展SYSTEM授权。
- `identity-authority-inspect-v1.mjs` 从独立进程实时核当前记录和API。离线签名记录不表示服务仍存活。

配置里的issuer必须与原共享认证配置一致；HTTP主站不接收身份DB维护凭据。公共版本里的路径和公钥属于部署信任信息，reader clientSecret、writer key和所有work材料保持私密。

## 仍需完成

这是入口边界与身份选择核验，尚未提供全局维护/请求排空、在途业务SQL提交与代数变化的原子围栏；不能宣称消除所有TOCTOU。其他后台worker、旧R2 owner/原workflow与KC接管、正式R5 owner、原R4冷恢复角色恢复准入、Linux部署与故障全矩阵仍继续。当前控制器用显式管理身份发布marker，生产管理凭据与服务进程隔离还需部署落实。

依赖本机Node24.20内置SQLite（该版本API为release candidate）和标准Keycloak26.8.1管理接口；[Node对应文档](https://raw.githubusercontent.com/nodejs/node/v24.20.0/doc/api/sqlite.md)、[Keycloak管理接口](https://www.keycloak.org/docs-api/latest/rest-api/index.html)。最终用户图文PDF/DOCX与实际讲解字幕MP4仍后置到同一验收版本。

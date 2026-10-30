# 镜像外身份权威与运行准入

原完整目标要求业务冷恢复不能回滚当前身份。上一层已证明真实身份整库迁移，本层把代数从内存/裸JSON提升为业务PGDATA外SQLite事务记录，连接新站点/对账worker入口。继续既定开发授权，不停止原运行源。

记录由独立Ed25519密钥签名形成revision/hash链，authority UUID与public key由独立runtime trust配置固定。SQLite WAL/synchronous FULL、BEGIN IMMEDIATE与expected revision CAS使并发写入和崩溃未提交事务不能产生两个有效head。迁移先在源停止/捕获前提交DRAINING，期间拒绝运行；目标恢复后核独立SQL绑定与源围栏，再转TRANSITION。ACTIVE只能在实际SQL绑定、旧源退役围栏及Keycloak API/SQL相同独有realm marker验证后提交。中途崩溃可以读原transition、使用同operation/challenge继续，不能生成新身份来掩盖未决状态。

运行时不持有身份DB owner/维护密码，只持有realm只读服务账户。每次读取最新签名链及ACTIVE head，读取Keycloak realm UUID/authorityId/epoch/challenge属性；原库恢复后旧marker即使同issuer/JWKS仍不能冒充新权威。写控制器持有独立维护与realm管理授权，SQL验证属性确实在候选DB中；不能只相信HTTP discovery或调用者布尔值。

新显式受保护站点入口基于真实R4 handler；新对账worker入口启动、领取前及普通授权resolve前后验证权威。旧R4与原运行不变；新入口不代表所有后台worker已升级，更不代表原R5 owner已安装。全局维护/请求排空和跨存储业务提交原子围栏仍后续完成，不能用HTTP边界检查宣称消除所有TOCTOU。

测试真实双PG/私有KC、真实整库迁移后的epoch2，再退回旧KC后端（自有源恢复连接模拟旧库配置复活），证明最新SQL/SQLite仍在而API旧marker被拒；真实R4站点和对账worker走新入口。测试进程重启读取、并发CAS、未提交进程退出、签名篡改、TRANSITION重入、只读账户拒绝写、错误issuer/trust/current backend。失败保留原件、资源精确清理。

控制SQLite/key/trust须部署在所有业务镜像与身份dump之外；不宣称抵御整个控制目录和独立trust一起回滚。SQLite存储迁移/日志轮转、大规模性能、全部服务原子接管、原环境legacy所有权移交仍待；最终PDF/DOCX图文和实际讲解字幕MP4保持原交付范围。

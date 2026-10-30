# 第二轮只读恢复的原PostgreSQL进程所有者

1. 现有PG owner1仅允许基础loopback/SCRAM配置，真实FIELD SOURCE包含精确只读角色HBA prefix。新owner2保留原spawn/ChildProcess、pidfile/SQL身份、目录/程序/完整离线tree、stdout/stderr、smart-stop助手唯一发送及实际原handle退出全部语句，改用既有pg-cold-review-config-v2严格解析。
2. 输入额外提供完整reviewEvidence，私有复制并冻结；HBA全字节hash、prefix hash、完整读role/database集合以及剩余基础profile均必须原样匹配。初始化和每次bind/inspect/stop均重核同一版本。这里只验证离线启动材料，不声称已验证加密archive或授予激活；生产组合仍由原冷控制验证SOURCE/backup。
3. 新真实临时PG16创建一个真实角色及精确prefix，正常停止后复制到各个独立新目录。验证实际新postmaster原handle、限定数据库连接、wrong hash和即便重hash仍带trust规则的拒绝、runtime drift/copy handle不发stop，以及仅一次原smart退出。
4. 不修改任何旧native/source案例。新原生完整恢复将用owner2启动第二轮目标，不覆盖仍须保留的原SOURCE目录、不收养PID。后续完整核心/FIELD、真实HELD/设备/批准与独立验收不变。

执行结果：原QA角色前缀设置错误导致首轮before-hook失败，生产owner2不改。新test3/runner2实际4/4 normal0+原host0，两个原新postmaster正常smart退出；原44文件、两SOURCE store和四fullmap材料不变。完整archive/SOURCE/reader HELD链尚待新Native；最新requirements-status-v30.json。

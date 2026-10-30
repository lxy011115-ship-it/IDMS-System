# 实施顺序

1. 签名SQLite链与固定trust、CAS/transition/active事务，独立进程读取与中断验证。
2. 实际SQL/Keycloak marker发布与只读API guard，不把身份DB维护密码交给站点。
3. 新显式站点和对账worker入口绑定issuer，启动/请求/任务前校验；旧源码见证保持。
4. 新隔离身份迁移和真实R4入口集成验证、旧后端复活拒绝、并发与故障重入、清理与Git发布。
5. 记录原生产控制器/原站切换、维护排空/提交围栏与最终交付未完成边界。

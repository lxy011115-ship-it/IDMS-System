# 执行计划：现场 SITE 正式应用管理

1. 实施 strict V2 manifest 及只读 SITE 包装开关核对；复用 V1 原有全部组件覆盖、租户和绑定校验。
2. 实施独立 SITE 结果验证器：真实结果绑定、正常/取消/异常分类、所有已创建资源退役与确定摘要。
3. registry V2 增加 CREATED、START_AUTHORIZED、RETIRED，保持 SQLite 快照/哈希链/文件身份验证；SITE 未退役禁止停止后台。
4. manager V3 接新 SITE child 的 CREATED→START；原始进程 close 后读取结果并登记退役；停止请求固定，缺证明时停止继续排空依赖。
5. 定向测试实际 fork 边界、严格配置、资源拒绝与 registry 顺序，并运行原应用 registry/child 回归和类型检查。
6. 后续接 suite/lifecycle 与平台依赖控制器实际 broker/edge，运行真实 enabled SITE 子进程和双平台全链；正式激活/历史迁移/治理切换等原待办保持。

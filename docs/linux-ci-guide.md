# GitHub Linux 基础检查

`.github/workflows/linux-verification.yml` 对 main、当前开发分支的 push 和针对 main 的 pull request 执行检查，使用 GitHub 的 Ubuntu 24.04 托管 runner 与部署中使用的 Node 24.20.0。默认分支有此工作流后也可手动触发。

执行 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定依赖，随后运行服务端单元测试、构建中的语法及 TypeScript 检查、新恢复入口的会话 Cookie 测试和恢复模块加载。模块加载不创建数据库或启动服务，CI 不使用本地运行目录或企业数据。

checkout 和 setup-node 使用从各自官方仓库版本标签核验的完整 commit SHA。工作流权限仅为读取仓库，checkout 不保留凭据；不使用云端或部署秘密、不自动部署、不写入阿里云。每次运行的摘要记录实际 commit、job 结果与检查边界。新增提交会取消相同分支尚未结束的旧检查。

工作流通过只证明其明确执行的 Linux 基础检查。完整 PostgreSQL 冷恢复、当前身份权威、Keycloak/Flowable、真实浏览器流程、原站接管及阿里云主机资源仍需各自实机验收，不能用绿色 CI 替代生产准入。

官方接口与配置说明：[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)。更新时应重新核验版本与对应 SHA。

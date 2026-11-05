# 部署资料与当前系统差异核对

日期：2026-11-05。核对基线为`ff6cd8d5fc0e0ecc3248f4e2d61b85a9505fabfb`。结论：根Compose和`deploy/`历史资料不能作为当前完整企业系统的部署包。此前内部试运行记录继续作为其时点证据，不能据其健康200或源码摘要宣称当前版本已在云端交付。

本次只读检查了27个关键文件，并把历史清单中的958个文件逐一与本地现存字节比较。未执行任何部署脚本、初始化、迁移、账号配置、容器、服务管理、云API、DNS或证书操作。原24项运行绑定、10个进程身份及485项运行源码保持。

## 已确认的差异

| 项目 | 本次依据 | 交付影响 |
| --- | --- | --- |
| 发布摘要过时 | `deploy/source-export.json`958项仍全部存在，924项相同、34项已变；当前源码清单3943项中2985项不在旧清单内 | 旧摘要只能验证旧文件集，不能验证现版。差异含主站、权限、采集、容量、证明及服务入口；新增文件也包含文档/测试，不能把2985全部当作缺失运行模块 |
| 历史摘要本身完整 | `cloud-code-checksums.json`引用的baseManifest SHA仍与历史清单相符，目标分支记为main | 不是“旧清单损坏”；问题是旧发布范围与当前release分支不同，不能修改旧收据制造同版结果 |
| 根Compose未固定镜像字节 | 6个image均无`@sha256`，含浮动主/次版本及latest标签 | 不能从相同标签推定未来安装字节相同。云端镜像记录保存了Keycloak档案与配置摘要，但PostgreSQL仍只有16标签；配置摘要与注册表manifest摘要也不可混用 |
| 默认口令与开发身份模式 | 根Compose有4处密码回退表达式，Keycloak使用start-dev；`.env.example`含历史占位值 | 不能复制示例后直接作为正式环境。云端历史脚本使用随机密码、受限应用角色及Keycloak start，与根骨架分别评价 |
| 端口范围 | 根Compose发布4010、1883、18083及8080时均未指定宿主IP；主站源码监听127.0.0.1 | 根Compose没有给出与现有回环主站一致的代理路径；不能用关闭生产门禁或随意改成所有地址监听来“修通” |
| 依赖顺序 | 根Compose使用短形式depends_on；未给主站配置完整业务就绪检查 | 容器running与业务ready不同；数据库、登录及外部回执链需按真实契约验收 |
| 服务不完整 | 根Compose没有Flowable、预测器、模型或边缘服务；AI项是可选nginx占位。历史云试运行明确只提供主站/数据库/身份子集 | 功能降级模式不能被标记为完整企业部署，也不能用占位HTTP200替代真实AI或工作流回执 |
| 备件迁移缺口 | 历史bootstrap调用通用migrateTenant，不调用setup-spares或setup-spares-insights；其输出迁移凭据位于`/srv/idms/private`，专用脚本默认读取`.local/postgres-migration.json` | 完整部署需要显式、独立的当前迁移编排和正确文件绑定；不能直接接一条专用命令、复制管理员凭据到运行目录或把迁移放进普通启动 |
| 根身份realm落后 | 当前角色目录12类，根realm仅7类，缺system-admin、platform-certifier、production-supervisor、operator、spare-parts-clerk；还缺sites/lines/devices三个范围mapper | 根realm不能直接等同于当前岗位模型。历史云端configure-identity会读取当前角色并设置范围mapper，但这是会写入身份配置的初始化器，不应为升级而重跑 |
| 旧检查覆盖不足 | verify-internal只测health、匿名拒绝、页面及PKCE跳转等，不测ready/runtime-status、备件或交互式登录，且明确productionAcceptance=false | 8项历史内部检查不是当前岗位验收或正式上线证明 |
| 旧unit能力未对应现版 | 160MiB V8堆、256M cgroup、60%CPU、64任务及45秒停止窗口；无就绪/容量配置及维护令牌注入 | 这些是早期小型内部试运行设置，尚无当前完整负载、排空与峰值资源证据；逻辑任务预算不能直接换算成RSS或cgroup所需内存 |
| 运维策略未落地 | 公开巡检示例的磁盘阈值和备份最大年龄为null；巡检是手动入口 | 未确定容量、留存、恢复目标、告警接收人和支持责任，不能把示例默认值当作已确认政策 |
| HTTPS仍是待激活模板 | nginx.pending只有HTTP跳转/ACME占位，尚无完整TLS及身份上游配置 | 不是可直接安装的HTTPS站点；本次没有核实当前云端、备案或证书状态 |

这里的“缺角色”是配置文件差异，不是对任何服务器现有用户角色分配的判断。本次也没有尝试在原企业库初始化备件或重建realm。

## 官方行为依据与需要实测的部分

Docker未指定宿主IP的发布端口默认映射到宿主各地址；短depends_on只保证启动次序，不保证业务就绪。因此上表中的公开范围和就绪缺口有配置依据，但未在本机执行容器网络试验。[端口发布](https://docs.docker.com/engine/network/port-publishing/)、[启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)。

Docker Compose按服务授予文件secret访问；`_FILE`只是部分镜像约定，并不是所有应用自动支持。IDMS已有受限JSON配置和密钥文件，应按各组件真实读取方式接入，不能只增加一个secret声明就声称完成秘密管理。[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。

Keycloak的公开hostname、代理路径及可信代理头必须与实际代理模式一致；代理应覆写相关头，后端访问范围也要限制。本机回环issuer和公网`https://idms.xin/identity`是不同部署绑定，不能只在nginx加一条转发。[Keycloak反向代理](https://www.keycloak.org/server/reverseproxy)。

systemd默认先发送SIGTERM，停止超时后通常进一步SIGKILL。IDMS源码有SIGTERM正常收尾入口，但旧unit的45秒是否覆盖完整负载尚未实测；不能把systemctl结束或超时杀进程当作业务排空成功。[systemd官方停止行为](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml)。

本机没有Docker或bash命令，也没有YAML解析库；Compose结论来自固定摘要的源码观察，并非`docker compose config`或部署实演。未下载新依赖补出一个表面成功结果。Java、数据库及模型候选的现有局部验证沿用其原范围，不从这次资料核对推定新的版本安全结论。

## 建议的下一步

先建立与部署方式分离的发布契约和只读预检：精确源版本、程序/镜像字节、全部服务及端口、当前备件迁移能力、服务身份/私密文件权限、真实就绪、正常收尾、配对恢复证据和运维责任都必须可核对。缺失项明确NOT_READY；检查成功本身不授予生产批准。

完整设计见[发布契约与只读预检候选](superpowers/specs/2026-11-05--release-contract-and-readonly-preflight.md)。它与尚待选择的增量业务架构分别处理；不会批准后者、移除production门禁、重新配置账号或执行云端部署。

本机证据为`.local/deployment-audits/20596de6-9fd2-4e9c-b338-44d91c61e9f2/audit.private.json`，包含27个文件摘要、958项逐文件状态及观察方法。执行源在`work/existing-platform-20261031/audit-deployment-materials-20261105.mjs`。原始私密运行事实不随公开报告发布。

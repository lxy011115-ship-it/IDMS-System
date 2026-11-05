# 工作流运行依赖安全复核（2026-11-05）

结论：当前工作流包存在需要处理的依赖版本差距，尚未完成生产安全验收。`npm audit`的结果不能覆盖此Java服务。版本命中与实际可利用性分别记录；本轮没有发送利用请求或替换运行包。

## 实际检查对象

核对当前运行绑定中的`services/workflow/target/idms-workflow-0.1.0.jar`：34,313,053字节，SHA-256为`c1530edc77714764a6fa82bf76a6031b1048dcad18cc35ae726d00a13be982a9`。只读枚举其90个`BOOT-INF/lib`依赖，逐个记录长度、摘要及可获得的Maven元数据，没有仅凭POM推断运行版本，也没有执行该JAR。

| 组件 | 实际打包版本 |
| --- | --- |
| Spring Boot | 3.5.7 |
| Spring Framework（含MVC） | 6.2.12 |
| Tomcat嵌入组件 | 10.1.48 |
| Jackson Databind/Core | 2.19.2 |
| pgJDBC | 42.7.8 |
| Apache Commons Lang | 3.17.0 |
| Flowable引擎 | 7.2.0 |

JAR内`application.properties`与源码逐字相符，配置监听`127.0.0.1`；实际工作流进程的监听地址为`127.0.0.1:4016`。包内没有应用静态资源目录。以上只证明本次本机事实，不证明云端相同，也不将本地监听视为补丁替代品。

## 公告与适用性

| 项目 | 版本判断与触发条件 | 当前证据及后续处理 |
| --- | --- | --- |
| Tomcat：CVE-2026-24880 | 10.1.48落入受影响范围；公告涉及前置代理接受特定分块扩展的情形 | 本机服务只监听回环；生产代理配置尚未验收。保留待修复，不声称已证实本机请求走私。[Apache公告](https://tomcat.apache.org/security-10.html) |
| Tomcat：CVE-2026-77791 | 10.1.48落入受影响范围；涉及WebSocket关闭处理 | 应用源码未声明WebSocket端点；依赖存在不等于端点暴露。仍需升级及候选包复核。[Apache公告](https://tomcat.apache.org/security-10.html) |
| Spring：CVE-2026-41841 | 6.2.12落入范围；需要多个资源处理器、受保护资源及共享缓存组合 | 自有源码未配置这种资源处理链，包内应用静态资源数为0；没有据此豁免整个Spring版本。[Spring公告](https://spring.io/security/cve-2026-41841/) |
| Spring：CVE-2026-59283 | 6.2.12落入范围；需要`SimpleEvaluationContext`及表达式编译 | 自有源码未配置此组合，尚未全面证明第三方内部调用不可达。6.2.19仍在此公告范围，6.2.20修复标为商业支持；不能将只升级到6.2.19当作全部关闭。[Spring公告](https://spring.io/security/cve-2026-59283/) |
| Jackson：CVE-2026-110879 | 2.19.2落入范围；涉及类名多态反序列化 | 自有接口主要读取`JsonNode`及固定记录，未发现主动启用类名默认类型；第三方内部路径仍待候选验证。公告列出2.21.8等修复版本，须与整套Jackson及Flowable兼容验证。[维护者公告](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-m8xf-2cr7-77ph) |
| pgJDBC：CVE-2026-107315 | 42.7.8落入范围；需要实际写入长度小于声明长度的相关二进制接口 | 自有源码未直接调用公告列出的写入接口，未完成Flowable/MyBatis内部路径证明。公告修复版本为42.7.14。[pgJDBC公告](https://jdbc.postgresql.org/security/) |
| Commons Lang：CVE-2025-48924 | 3.17.0落入范围；过长输入到达`ClassUtils.getClass`可导致递归耗尽 | 自有源码未直接调用，第三方调用条件仍需核对；公告修复下限3.18.0。[Apache公告](https://lists.apache.org/thread/bgv0lpswokgol11tloxnjfzdl7yrc1g1) |

反向核对：当前pgJDBC 42.7.8不在CVE-2026-107314声明的42.7.11至42.7.13区间；当前Tomcat 10.1.48也不在CVE-2025-61795截止10.1.46的区间。不会仅因检索到公告就把它们列为当前命中。未检索到某个组件的特定公告，也不证明该组件无漏洞。

这是一轮针对重点依赖的官方公告复核，不是90个依赖全部公告、JVM、操作系统、Keycloak和生产网络的完整安全评估。源码中的“未发现”只是本轮搜索范围，不是运行路径不可达的完整证明。

## 修复候选的验收要求

1. 在隔离目录锁定整套依赖和来源，重新输出实际JAR依赖清单；不能只修改POM版本或手工替换嵌套JAR。选择Spring发布线时同时核实支持范围、Flowable及Jackson兼容性。
2. 保留现有流程定义、企业边界、独立终审和幂等命令契约；普通启动继续使用现有结构，不隐式初始化、迁移或重新部署流程定义。
3. 在合成隔离库验证维修流程、回执重试、原键摘要冲突、企业隔离、恢复只读接口及未授权拒绝。对公告的相关配置分别记录适用性，不能以服务健康接口200代替业务验证。
4. 验证当前完整平台的一致备份、还原和回退，以及实际正常停止。Windows强制结束Java进程不构成正常退出证明；观察超时也不构成已退出。
5. 候选通过后再形成具体运行绑定及切换影响；本轮没有构建新包、换版、重启或变更数据库。既有增量架构设计仍等待原评审，不把本报告当作批准。

逐依赖摘要、配置检查和实际进程身份收据保留在本机私密`work/existing-platform-20261031`目录，不提交企业配置、凭据或运行档案。

## 后续补充：全坐标索引筛查与迁移探测

已将实际90个嵌套库全部纳入OSV坐标筛查：69个含Maven元数据，其余21个通过Maven Central HTTPS发布摘要与实际JAR字节匹配确认坐标。多个内嵌坐标均保留，共97项查询、14个匹配坐标、63个去重公告ID。原始查询、响应及逐坐标摘要证据保留本机；这些是索引版本匹配，逐公告实际触发条件和企业环境可利用性仍需复核，不等于63个已验证漏洞。

本次索引没有返回此前已由维护者公告核实的`GHSA-m8xf-2cr7-77ph`，即使Jackson坐标已经参与查询。因此不以索引零命中关闭维护者公告。新增索引结果还涉及Logback、Log4j API和OGNL，须与原Spring/Tomcat/Jackson/pgJDBC/Commons Lang问题一并处理。[OSV接口及分页约定](https://google.github.io/osv.dev/post-v1-querybatch/)

独立副本仅替换Boot/Flowable版本后，有效POM解析出Boot 4.1.2、Spring 7.0.10、Tomcat 11.0.27及pgJDBC 42.7.14。实际依赖树使用Jackson 3.1.7；POM还管理Jackson 2.21.7，但该树不包含Jackson 2 Databind。两条默认版本线均需注意相应公告，不能把POM管理项当作实际打包项。6份原Java源码编译实际失败，错误涉及Boot自动配置包及旧Jackson类型；本次未得到通过的修复JAR。先前TLS失败与后续实际编译失败分别保留，不混为一项。另行对21组合成摘要向量进行原Jackson 2.19.2与2.21.8的真实Java比较，均与Node一致；该探测不执行Controller或引擎，不证明Jackson 3和完整HTTP契约已经兼容。

Flowable 8涉及Boot模块、Jackson及历史表结构变化，需显式迁移和回退。完整可评审范围、替代路线及验收要求见[工作流安全维护设计](superpowers/specs/2026-11-05--workflow-security-maintenance.md)。当前运行JAR、企业数据库及账号未变更，整体安全验收继续保持未完成。

另已实证嵌套依赖遗漏风险：新树没有独立OGNL节点，实际MyBatis 3.5.19却与原包字节相同，内含OGNL 3.4.4元数据。因此修复范围包含承载包内部的重定位代码；单独升级`ognl:ognl`不能据此宣称MyBatis内部已修复。

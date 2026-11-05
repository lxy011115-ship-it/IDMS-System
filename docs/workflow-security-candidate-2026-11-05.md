# 工作流开源迁移：首批候选实现与构建

日期：2026-11-05。用户已批准路线A，独立候选源码位于src/workflow-security-candidate。当前结果是编译、JSON协议转换及打包通过；不是数据库迁移、全部业务路由或安全交付已完成。原services/workflow、原JAR及原10服务保持。

## 已完成的改动

- Boot 4.1.2、Flowable 8.0.0、Jackson 3.1.8及MyBatis 3.6.0被显式锁定；没有用Jackson 2过渡路线替代已批准的Jackson 3目标。
- 六份原Java源码迁移Jackson树/reader及Boot JDBC自动配置包，保留恢复读取、撤销协调和撤销预留控制器。BPMN资源字节与原版完全一致，不修改定义版本。
- 三处规范摘要序列化改用同一个WorkflowJson实现，保持原有排序和标量序列化规则。版本报告读取实际ProcessEngine.VERSION；此发行包实际返回8.0.0.0，没有继续硬编码7.2.0。
- 真实HTTP JSON转换器启用重复字段拒绝；普通命令在record映射前校验整数版本、固定actor字段和文本类型，拒绝字符串/小数隐式转为版本号、整数溢出、缺失actor、未知字段和错误actor类型。可选字段仍允许省略或null，当前21组向量的规范字节和摘要一致；完整允许输入范围的解析/摘要差异仍须下一阶段验证。
- 修正遗留application.properties的Boot自动配置全限定名。普通启动继续校验模式，显式initialize仍为维护入口；数据库迁移门禁和回退仍须后续实现、验证，当前不启动候选服务。

## 实际验证

最新Maven verify真实exit0，8份主源码、2份测试源码，6个测试全部通过，未跳过测试；最终这次使用已验证的本机依赖缓存，网络请求0。6个测试分别覆盖原21向量的规范字节和SHA、撤销reader重复字段、普通启动模式与实际版本，以及配置后的HTTP转换器21向量、重复字段/未知record字段、普通命令错误类型边界。HTTP转换器测试运行实际Boot Jackson自动配置，但没有启动业务Controller或连接数据库。

首次候选编译已成功，测试误预期引擎版本为8.0.0，实际为8.0.0.0。该失败及所有输入/日志保留，只修正测试的发行格式预期；第二次构建通过并保留其JAR和源码。之后修复遗留配置并增加上述HTTP/类型检查，形成最新第三次成功构建。没有通过跳过失败测试、删接口或修改原服务取得通过。

实际打包JAR 33838193字节，SHA-256 cd9441c5856430458ce294dfa7d28b01dd11b7f501b090e927f4adf1d5950dc8，包含98个嵌套库。逐库字节和可用Maven元数据已建立索引。实际嵌套MyBatis 3.6.0与本次正常上游TLS/发布摘要核验取得的Maven文件字节一致，并包含OGNL 3.4.16元数据及重定位类；没有只增加独立OGNL依赖冒充覆盖。Jackson Databind实际为3.1.8，不含2.x Databind。完整公告适用性、表达式/SQL行为及全部依赖安全复核尚未完成。

MyBatis来源见[3.6.0正式发行](https://github.com/mybatis/mybatis-3/releases/tag/mybatis-3.6.0)及[该tag的依赖和重定位配置](https://github.com/mybatis/mybatis-3/blob/mybatis-3.6.0/pom.xml)。Jackson路线遵循[Boot JSON支持说明](https://docs.spring.io/spring-boot/reference/features/json.html)。这些来源与实际包索引配合使用，不能单靠版本声明关闭安全项。

## 后续门禁

继续执行[已批准实施计划](superpowers/plans/2026-11-05--workflow-security-maintenance.md)：合成双企业非空/在途/撤销预留数据、受限身份下的显式引擎SQL迁移、全部九路由及权限/竞争/回滚、原键回执重放、升级前后和旧JAR真实回退，以及实际打包依赖的完整安全复核。未通过前不替换原JAR或迁移原数据库。

GitHub新增独立候选构建检查，只编译、测试和打包候选；不取得生产凭据、不连接企业库、不部署。原485项运行源码摘要、24绑定和10进程身份已经复核保持。本机私密证据索引：work/existing-platform-20261031/workflow-security-first-build-delivery-20261105.json。

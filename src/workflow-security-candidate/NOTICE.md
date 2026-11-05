# Third-party source attribution

`WorkflowJdbcMappings.java` adapts the JDBC type registrations from Flowable
8.0.0 `AbstractEngineConfiguration.initMybatisTypeHandlers`.
`WorkflowEngineConfiguration.java` preserves the additional process-variable
registration from `ProcessEngineConfigurationImpl.initMybatisTypeHandlers`.

Both upstream sources are distributed under the Apache License, Version 2.0.
The license is included in [third-party-licenses/Apache-2.0.txt](third-party-licenses/Apache-2.0.txt).
The original license header is retained on the adapted common mappings.

Changes made by IDMS: move the mappings into an application-owned helper,
compile calls against MyBatis 3.6's `Type` signature, and install them through
the process and event-registry configuration extension points. No upstream
JAR, mapper XML, or shaded class is patched.

Upstream sources:

- [AbstractEngineConfiguration at flowable-8.0.0](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/modules/flowable-engine-common/src/main/java/org/flowable/common/engine/impl/AbstractEngineConfiguration.java)
- [ProcessEngineConfigurationImpl at flowable-8.0.0](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/modules/flowable-engine/src/main/java/org/flowable/engine/impl/cfg/ProcessEngineConfigurationImpl.java)

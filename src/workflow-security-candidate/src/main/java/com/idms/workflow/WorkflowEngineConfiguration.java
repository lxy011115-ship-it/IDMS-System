package com.idms.workflow;

import org.apache.ibatis.session.Configuration;
import org.flowable.common.engine.impl.EngineConfigurator;
import org.flowable.eventregistry.spring.SpringEventRegistryEngineConfiguration;
import org.flowable.eventregistry.spring.configurator.SpringEventRegistryConfigurator;
import org.flowable.spring.SpringProcessEngineConfiguration;

/** Application-owned compatibility at Flowable's configuration extension points. */
final class WorkflowEngineConfiguration extends SpringProcessEngineConfiguration {
    @Override
    public void initMybatisTypeHandlers(Configuration configuration) {
        WorkflowJdbcMappings.register(configuration, getDatabaseType());
        // Preserve ProcessEngineConfigurationImpl's additional mapping as well as
        // the common JDBC mappings. Calling super would use the incompatible ABI.
        configuration.getTypeHandlerRegistry().register(
            org.flowable.variable.api.types.VariableType.class,
            org.apache.ibatis.type.JdbcType.VARCHAR,
            new org.flowable.variable.service.impl.db.IbatisVariableTypeHandler(getVariableTypes()));
    }

    @Override
    protected EngineConfigurator createDefaultEventRegistryEngineConfigurator() {
        var configurator = new SpringEventRegistryConfigurator();
        configurator.setEventEngineConfiguration(new EventConfiguration());
        return configurator;
    }

    static final class EventConfiguration extends SpringEventRegistryEngineConfiguration {
        @Override
        public void initMybatisTypeHandlers(Configuration configuration) {
            WorkflowJdbcMappings.register(configuration, getDatabaseType());
        }
    }
}

package com.idms.workflow;

import static org.junit.jupiter.api.Assertions.*;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.type.*;
import org.flowable.common.engine.impl.db.FlowableStringTypeHandler;
import org.junit.jupiter.api.Test;

class WorkflowMybatisCompatibilityTest {
    @Test
    void postgresInitializationKeepsFlowableJdbcMappingsWithThePinnedMybatis() {
        var engine = new WorkflowEngineConfiguration();
        engine.setDatabaseType("postgres");
        var configuration = new Configuration();
        assertDoesNotThrow(() -> engine.initMybatisTypeHandlers(configuration));
        var registry = configuration.getTypeHandlerRegistry();
        assertInstanceOf(BooleanTypeHandler.class, registry.getTypeHandler(Object.class, JdbcType.BOOLEAN));
        assertInstanceOf(IntegerTypeHandler.class, registry.getTypeHandler(Object.class, JdbcType.INTEGER));
        assertInstanceOf(FlowableStringTypeHandler.class, registry.getTypeHandler(Object.class, JdbcType.NVARCHAR));
        assertInstanceOf(BlobInputStreamTypeHandler.class, registry.getTypeHandler(Object.class, JdbcType.BLOB));
        assertInstanceOf(DateTypeHandler.class, registry.getTypeHandler(Object.class, JdbcType.TIMESTAMP));
    }

    @Test
    void enabledEventRegistryUsesTheSameCompatibleMappings() {
        var engine = new WorkflowEngineConfiguration.EventConfiguration();
        engine.setDatabaseType("postgres");
        var configuration = new Configuration();
        assertDoesNotThrow(() -> engine.initMybatisTypeHandlers(configuration));
        assertInstanceOf(IntegerTypeHandler.class,
            configuration.getTypeHandlerRegistry().getTypeHandler(Object.class, JdbcType.INTEGER));
    }

    @Test
    void schemaRefusalIsDistinguishedFromOtherStartupFailuresWithoutLeakingMessages() {
        var wrong = new org.flowable.common.engine.api.FlowableWrongDbException("8.0.0.0", "7.2.0.2");
        assertEquals("WORKFLOW_SCHEMA_VERSION_MISMATCH", WorkflowStartup.rejectionCategory(new RuntimeException(wrong)));
        assertEquals("WORKFLOW_ENGINE_STARTUP_FAILED", WorkflowStartup.rejectionCategory(new RuntimeException("private credential")));
        assertEquals("WORKFLOW_INITIALIZATION_REQUIRES_EMPTY_SCHEMA", WorkflowStartup.rejectionCategory(new IllegalStateException("WORKFLOW_INITIALIZATION_REQUIRES_EMPTY_SCHEMA")));
    }

    @Test
    void processVariableTypesStillResolveFromDatabaseTypeNames() throws Exception {
        var engine = new WorkflowEngineConfiguration();
        engine.setDatabaseType("postgres");
        var stringType = new org.flowable.variable.service.impl.types.StringType(4000);
        engine.setVariableTypes(new org.flowable.variable.service.impl.types.DefaultVariableTypes().addType(stringType));
        var configuration = new Configuration();
        engine.initMybatisTypeHandlers(configuration);
        var handler = configuration.getTypeHandlerRegistry()
            .getTypeHandler(org.flowable.variable.api.types.VariableType.class, JdbcType.VARCHAR);
        assertNotNull(handler);
        var result = org.mockito.Mockito.mock(java.sql.ResultSet.class);
        org.mockito.Mockito.when(result.getString("TYPE_")).thenReturn("string");
        assertSame(stringType, handler.getResult(result, "TYPE_"));
    }

    @Test
    void explicitInitializationFailsClosedForExistingOrUnknownSchemaBeforeDdl() {
        var sql = org.mockito.Mockito.mock(org.springframework.jdbc.core.JdbcTemplate.class);
        org.mockito.Mockito.when(sql.queryForObject(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.eq(Boolean.class)))
            .thenReturn(true, (Boolean)null, false);
        assertThrows(IllegalStateException.class, () -> WorkflowStartup.requireEmptyInitializationTarget(sql));
        assertThrows(IllegalStateException.class, () -> WorkflowStartup.requireEmptyInitializationTarget(sql));
        assertDoesNotThrow(() -> WorkflowStartup.requireEmptyInitializationTarget(sql));
        org.mockito.Mockito.verify(sql, org.mockito.Mockito.never()).execute(org.mockito.ArgumentMatchers.anyString());
    }
}

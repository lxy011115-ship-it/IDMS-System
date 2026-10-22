package com.idms.workflow;

import java.io.InputStream;
import java.security.MessageDigest;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.repository.ProcessDefinition;
import org.springframework.jdbc.core.JdbcTemplate;

/** Runtime never installs schema or deploys BPMN using its restricted APP identity. */
final class WorkflowRuntimeSchemaV1 {
    static boolean runtime(String mode) {
        if (mode == null || mode.equals("BOOTSTRAP")) return false;
        if (mode.equals("RUNTIME")) return true;
        throw new IllegalStateException("Unknown workflow schema mode");
    }
    static void verifyTables(JdbcTemplate sql) {
        sql.queryForList("SELECT entity_id,process_id,version,state,assignee,evidence_digest,submitted_by FROM public.idms_workflow_cases WHERE false");
        sql.queryForList("SELECT command_id,request_digest,response,created_at FROM public.idms_workflow_commands WHERE false");
    }
    static ProcessDefinition definition(ProcessEngine engine, String tenant) throws Exception {
        var query=engine.getRepositoryService().createProcessDefinitionQuery().processDefinitionKey("idmsMaintenanceV1").processDefinitionTenantId(tenant);
        if (query.count()!=1) throw new IllegalStateException("Expected one previously installed workflow definition");
        ProcessDefinition d=query.singleResult();
        if (d==null || !"maintenance-v1.bpmn20.xml".equals(d.getResourceName())) throw new IllegalStateException("Workflow definition identity changed");
        try (InputStream expected=WorkflowRuntimeSchemaV1.class.getClassLoader().getResourceAsStream("maintenance-v1.bpmn20.xml");InputStream actual=engine.getRepositoryService().getProcessModel(d.getId())) {
            if(expected==null || !MessageDigest.isEqual(expected.readAllBytes(),actual.readAllBytes())) throw new IllegalStateException("Workflow definition bytes changed");
        }
        return d;
    }
}

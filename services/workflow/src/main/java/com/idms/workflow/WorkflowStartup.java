package com.idms.workflow;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.*;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.repository.ProcessDefinition;
import org.springframework.jdbc.core.JdbcTemplate;

/** Ordinary startup validates reviewed deployment V1. Provisioning is an explicit maintenance mode. */
final class WorkflowStartup {
    static final String CONTRACT = "IDMS_EXISTING_WORKFLOW_V1";
    static final String RESOURCE = "maintenance-v1.bpmn20.xml";
    static final String KEY = "idmsMaintenanceV1";
    static final int VERSION = 1;
    static String mode(String value) {
        if (value == null || value.equals("runtime")) return "runtime";
        if (value.equals("initialize")) return value;
        throw new IllegalStateException("WORKFLOW_STARTUP_MODE_INVALID");
    }
    static String digest(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    static byte[] reviewedResource() throws Exception {
        try (InputStream stream = WorkflowStartup.class.getClassLoader().getResourceAsStream(RESOURCE)) {
            if (stream == null) throw new IllegalStateException("WORKFLOW_REVIEWED_RESOURCE_MISSING");
            byte[] bytes = stream.readNBytes(65537);
            if (bytes.length > 65536) throw new IllegalStateException("WORKFLOW_RESOURCE_SIZE");
            return bytes;
        }
    }
    static void validateTables(JdbcTemplate sql) {
        Map<String,List<String>> expected = Map.of(
            "idms_workflow_cases", List.of("entity_id:text:false", "process_id:text:true", "version:integer:false", "state:text:false", "assignee:text:false", "evidence_digest:text:true", "submitted_by:text:true"),
            "idms_workflow_commands", List.of("command_id:uuid:false", "request_digest:text:false", "response:jsonb:false", "created_at:timestamp with time zone:false"));
        for (var table : expected.entrySet()) {
            List<String> columns = sql.query("SELECT a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||CASE WHEN a.attnotnull THEN 'false' ELSE 'true' END FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=? AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", (r,i)->r.getString(1), table.getKey());
            if (!columns.equals(table.getValue())) throw new IllegalStateException("WORKFLOW_EXISTING_TABLE_MISMATCH");
            List<String> constraints = sql.query("SELECT pg_get_constraintdef(x.oid) FROM pg_constraint x WHERE x.conrelid=to_regclass(?) AND x.contype IN ('p','u') ORDER BY x.contype", (r,i)->r.getString(1), "public."+table.getKey());
            List<String> required = table.getKey().endsWith("cases") ? List.of("PRIMARY KEY (entity_id)", "UNIQUE (process_id)") : List.of("PRIMARY KEY (command_id)");
            if (!constraints.equals(required)) throw new IllegalStateException("WORKFLOW_EXISTING_CONSTRAINT_MISMATCH");
        }
        List<String> defaults=sql.query("SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='public.idms_workflow_commands'::regclass AND a.attname='created_at'",(r,i)->r.getString(1));
        if (!defaults.equals(List.of("now()"))) throw new IllegalStateException("WORKFLOW_EXISTING_DEFAULT_MISMATCH");
    }
    static ProcessDefinition definition(ProcessEngine engine, String tenant) throws Exception {
        var repository=engine.getRepositoryService();
        var definition=repository.createProcessDefinitionQuery().processDefinitionKey(KEY).processDefinitionTenantId(tenant).latestVersion().singleResult();
        if (definition==null || definition.getVersion()!=VERSION || definition.isSuspended() || !RESOURCE.equals(definition.getResourceName())) throw new IllegalStateException("WORKFLOW_EXISTING_DEFINITION_MISMATCH");
        try (var stream=repository.getResourceAsStream(definition.getDeploymentId(),RESOURCE)) {
            if (stream==null || !MessageDigest.isEqual(reviewedResource(),stream.readNBytes(65537))) throw new IllegalStateException("WORKFLOW_EXISTING_RESOURCE_MISMATCH");
        }
        return definition;
    }
}

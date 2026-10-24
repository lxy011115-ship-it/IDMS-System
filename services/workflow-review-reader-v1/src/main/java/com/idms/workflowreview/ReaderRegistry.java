package com.idms.workflowreview;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import org.flowable.engine.ProcessEngine;
import org.flowable.spring.SpringProcessEngineConfiguration;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;

/** Separate recovery reader: never installs schema, deploys a process, or accepts a writer account. */
@Component
public class ReaderRegistry {
    record Account(String jdbcUrl,String database,String databaseOid,String user,String roleOid,String password,
                   String recoveryReadToken,String recoveryAuthorityId,String bpmnSha256) {}
    record Config(int format,String purpose,Map<String,Account> tenants) {}
    record Tenant(ProcessEngine engine,JdbcTemplate sql,TransactionTemplate tx,HikariDataSource source,
                  byte[] recoveryToken,String recoveryAuthorityId,String database,String databaseOid,
                  String user,String roleOid,String bpmnSha256) {}
    private final Map<String,Tenant> tenants=new LinkedHashMap<>();
    private static void need(boolean ok) { if(!ok)throw new IllegalStateException("WORKFLOW_READER_BINDING_OR_PRIVILEGE_INVALID"); }
    private static boolean identifier(String s) { return s!=null&&s.matches("[a-z][a-z0-9_]{0,62}"); }
    private static boolean oid(String s) { return s!=null&&s.matches("[1-9][0-9]{0,9}"); }
    ReaderRegistry(ObjectMapper json) throws Exception {
        String config=System.getenv("IDMS_WORKFLOW_READER_CONFIG");need(config!=null);
        Path path=Path.of(config);need(path.isAbsolute()&&Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS)&&Files.size(path)>0&&Files.size(path)<=1048576);
        Config c=json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).readValue(Files.readAllBytes(path),Config.class);
        need(c.format()==1&&"WORKFLOW_RECOVERY_READER_V1".equals(c.purpose())&&c.tenants()!=null&&!c.tenants().isEmpty()&&c.tenants().size()<=32);
        try {
            Set<String> databases=new HashSet<>(),roles=new HashSet<>(),tokens=new HashSet<>();
            for(var entry:c.tenants().entrySet()) {
                String id=entry.getKey();Account a=entry.getValue();need(id!=null&&id.matches("[A-Za-z0-9_-]{1,80}")&&a!=null);
                need(identifier(a.database())&&identifier(a.user())&&oid(a.databaseOid())&&oid(a.roleOid()));
                need(a.jdbcUrl()!=null&&a.jdbcUrl().matches("jdbc:postgresql://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/"+a.database()));
                int port=Integer.parseInt(a.jdbcUrl().substring("jdbc:postgresql://127.0.0.1:".length(),a.jdbcUrl().lastIndexOf('/')));need(port<=65535);
                need(databases.add(a.jdbcUrl())&&roles.add(a.jdbcUrl()+":"+a.roleOid()));
                need(a.password()!=null&&a.password().length()>=32&&a.password().length()<=256&&a.recoveryReadToken()!=null&&a.recoveryReadToken().matches("[A-Za-z0-9_-]{43,256}")&&!a.recoveryReadToken().equals(a.password())&&tokens.add(a.recoveryReadToken()));
                need(a.recoveryAuthorityId()!=null&&a.recoveryAuthorityId().matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")&&a.bpmnSha256()!=null&&a.bpmnSha256().matches("[a-f0-9]{64}"));
                HikariDataSource source=new HikariDataSource();ProcessEngine engine=null;
                try {
                    source.setJdbcUrl(a.jdbcUrl());source.setUsername(a.user());source.setPassword(a.password());source.setMaximumPoolSize(2);source.setMinimumIdle(0);source.setPoolName("workflow-reader-"+id);source.setReadOnly(true);source.setConnectionInitSql("SET default_transaction_read_only=on");source.setConnectionTimeout(5000);
                    JdbcTemplate sql=new JdbcTemplate(source);sql.setQueryTimeout(15);var tm=new DataSourceTransactionManager(source);var tx=new TransactionTemplate(tm);
                    Tenant t=new Tenant(null,sql,tx,source,("Bearer "+a.recoveryReadToken()).getBytes(StandardCharsets.UTF_8),a.recoveryAuthorityId(),a.database(),a.databaseOid(),a.user(),a.roleOid(),a.bpmnSha256());verify(t);
                    var e=new SpringProcessEngineConfiguration();e.setDataSource(source);e.setTransactionManager(tm);e.setDatabaseSchemaUpdate("false");e.setAsyncExecutorActivate(false);e.setHistory("full");e.setEngineName("idms-recovery-reader-"+id);e.setDisableIdmEngine(true);
                    engine=e.buildProcessEngine();
                    var definitions=engine.getRepositoryService().createProcessDefinitionQuery().processDefinitionKey("idmsMaintenanceV1").processDefinitionTenantId(id);need(definitions.count()==1);
                    var d=definitions.singleResult();need(d!=null&&d.getVersion()==1&&!d.isSuspended()&&"maintenance-v1.bpmn20.xml".equals(d.getResourceName()));
                    try(var in=engine.getRepositoryService().getProcessModel(d.getId())) { byte[] b=in.readNBytes(262145);need(b.length<=262144&&HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b)).equals(a.bpmnSha256())); }
                    verify(t);tenants.put(id,new Tenant(engine,sql,tx,source,t.recoveryToken(),t.recoveryAuthorityId(),t.database(),t.databaseOid(),t.user(),t.roleOid(),t.bpmnSha256()));
                } catch(Exception problem) {
                    try { if(engine!=null)engine.close(); } catch(Exception close) { problem.addSuppressed(close); }
                    try { source.close(); } catch(Exception close) { problem.addSuppressed(close); }
                    throw problem;
                }
            }
        } catch(Exception problem) { try { close(); } catch(Exception close) { problem.addSuppressed(close); } throw problem; }
    }
    /** SQL privileges are checked again inside each request's read-only RR transaction. */
    void verify(Tenant t) {
        var r=t.sql().queryForMap("SELECT current_user AS usr,session_user AS session,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db_oid,current_database() AS db,oid::text AS role_oid,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user");
        need(t.user().equals(r.get("usr"))&&t.user().equals(r.get("session"))&&t.database().equals(r.get("db"))&&t.databaseOid().equals(r.get("db_oid"))&&t.roleOid().equals(r.get("role_oid"))&&Boolean.TRUE.equals(r.get("rolcanlogin")));
        for(String key:List.of("rolsuper","rolcreatedb","rolcreaterole","rolinherit","rolreplication","rolbypassrls"))need(Boolean.FALSE.equals(r.get(key)));
        need(t.sql().queryForObject("SELECT count(*) FROM pg_auth_members WHERE member=?::oid OR roleid=?::oid",Long.class,t.roleOid(),t.roleOid())==0);
        need(!t.sql().queryForObject("SELECT has_database_privilege(current_database(),'CREATE,TEMP')",Boolean.class));
        need(!t.sql().queryForObject("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datdba=?::oid) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=?::oid) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=?::oid) OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=?::oid)",Boolean.class,t.roleOid(),t.roleOid(),t.roleOid(),t.roleOid()));
        need(!t.sql().queryForObject("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema' AND has_schema_privilege(oid,'CREATE'))",Boolean.class));
        need(!t.sql().queryForObject("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND ((c.relkind IN('r','p','v','m','f') AND has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR (c.relkind='S' AND has_sequence_privilege(c.oid,'USAGE,UPDATE')) OR (c.relkind IN('v','m','f') AND has_table_privilege(c.oid,'SELECT'))))",Boolean.class));
        need(!t.sql().queryForObject("SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname!~'^pg_' AND n.nspname<>'information_schema' OR n.nspname='pg_catalog' AND (p.proname LIKE 'lo\\_%' ESCAPE '\\' OR p.proname IN('lowrite','loread','loopen','loclose'))) AND has_function_privilege(p.oid,'EXECUTE'))",Boolean.class));
        need("on".equals(t.sql().queryForObject("SHOW transaction_read_only",String.class)));
    }
    Tenant recoveryTenant(HttpServletRequest request) {
        Tenant t=tenants.get(request.getHeader("X-IDMS-Tenant"));String token=request.getHeader("Authorization");
        if(t==null||token==null||!MessageDigest.isEqual(t.recoveryToken(),token.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Invalid recovery reader identity");
        if(Collections.list(request.getHeaders("Authorization")).size()!=1||Collections.list(request.getHeaders("X-IDMS-Tenant")).size()!=1)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Duplicate recovery identity");return t;
    }
    Map<String,Object> recoveryView(Tenant t,String id) {
        var rows=t.sql().queryForList("SELECT * FROM idms_workflow_cases WHERE entity_id=?",id);need(rows.size()==1);var row=rows.getFirst();String pid=(String)row.get("process_id");
        var h=t.engine().getHistoryService().createHistoricProcessInstanceQuery().processInstanceId(pid).singleResult();need(h!=null);
        Map<String,Object> v=new LinkedHashMap<>();v.put("entityId",id);v.put("state",row.get("state"));v.put("version",row.get("version"));v.put("processInstanceId",pid);v.put("definitionId",h.getProcessDefinitionId());v.put("ended",h.getEndTime()!=null);
        v.put("tasks",t.engine().getTaskService().createTaskQuery().processInstanceId(pid).list().stream().map(a->Map.of("id",a.getId(),"key",a.getTaskDefinitionKey(),"name",a.getName(),"assignee",Objects.toString(a.getAssignee(),""))).toList());
        v.put("history",t.engine().getHistoryService().createHistoricTaskInstanceQuery().processInstanceId(pid).orderByHistoricTaskInstanceStartTime().asc().list().stream().map(a->Map.of("id",a.getId(),"key",a.getTaskDefinitionKey(),"assignee",Objects.toString(a.getAssignee(),""),"startedAt",Objects.toString(a.getStartTime(),""),"endedAt",Objects.toString(a.getEndTime(),""))).toList());return v;
    }
    @PreDestroy void close() {
        RuntimeException problem=null;
        for(Tenant t:tenants.values()) {
            try { t.engine().close(); } catch(RuntimeException e) { if(problem==null)problem=e;else problem.addSuppressed(e); }
            try { t.source().close(); } catch(RuntimeException e) { if(problem==null)problem=e;else problem.addSuppressed(e); }
            Arrays.fill(t.recoveryToken(),(byte)0);
        }
        tenants.clear();if(problem!=null)throw problem;
    }
}

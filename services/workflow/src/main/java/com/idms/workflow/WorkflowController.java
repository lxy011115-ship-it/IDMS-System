package com.idms.workflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.TaskService;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.task.Comment;
import org.flowable.spring.SpringProcessEngineConfiguration;
import org.flowable.task.api.Task;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

@RestController
public class WorkflowController {
    record Account(String jdbcUrl,String user,String password,String serviceToken,String recoveryReadToken,String recoveryAuthorityId) {}
    record Config(Map<String,Account> tenants) {}
    record Actor(String id,String type,List<String> permissions) {}
    record Command(String commandId,String requestDigest,String entityId,String action,int expectedVersion,Actor actor,String assignee,String evidenceDigest,String decision,String comment,String correlationId) {}
    record Tenant(ProcessEngine engine,JdbcTemplate sql,TransactionTemplate tx,HikariDataSource source,byte[] token,String definitionId,byte[] recoveryToken,String recoveryAuthorityId) {}
    private final Map<String,Tenant> tenants=new HashMap<>();
    private final ObjectMapper json;
    private final String startupMode=WorkflowStartup.mode(System.getenv("IDMS_WORKFLOW_STARTUP_MODE"));
    WorkflowController(ObjectMapper json) throws Exception {
        this.json=json;
        String configPath=System.getenv("IDMS_WORKFLOW_CONFIG");
        if(configPath==null)throw new IllegalStateException("Private workflow configuration is required");
        Config config=json.readValue(Files.readString(Path.of(configPath)),Config.class);
        for(var entry:config.tenants().entrySet()){
            String tenantId=entry.getKey();Account a=entry.getValue();
            if(!tenantId.matches("[A-Za-z0-9_-]{1,80}")||a.serviceToken().length()<32||!a.jdbcUrl().startsWith("jdbc:postgresql://127.0.0.1:"))throw new IllegalStateException("Invalid local workflow account binding");
            if((a.recoveryReadToken()==null)!=(a.recoveryAuthorityId()==null)||a.recoveryReadToken()!=null&&(a.recoveryReadToken().length()<32||a.recoveryReadToken().length()>256||a.recoveryReadToken().equals(a.serviceToken())||!a.recoveryAuthorityId().matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")))throw new IllegalStateException("Invalid recovery reader binding");
            HikariDataSource source=new HikariDataSource();source.setJdbcUrl(a.jdbcUrl());source.setUsername(a.user());source.setPassword(a.password());source.setMaximumPoolSize(3);source.setPoolName("workflow-"+tenantId);
            var tm=new DataSourceTransactionManager(source);var sql=new JdbcTemplate(source);
            ProcessEngine engine=null;
            try {
            boolean initialize=startupMode.equals("initialize");
            if(initialize){
                sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_cases (entity_id text PRIMARY KEY,process_id text UNIQUE,version integer NOT NULL,state text NOT NULL,assignee text NOT NULL,evidence_digest text,submitted_by text)");
                sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_commands (command_id uuid PRIMARY KEY,request_digest text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
            }
            WorkflowStartup.validateTables(sql);
            var c=new SpringProcessEngineConfiguration();c.setDataSource(source);c.setTransactionManager(tm);c.setDatabaseSchemaUpdate(initialize?"true":"false");c.setAsyncExecutorActivate(false);c.setHistory("full");c.setEngineName("idms-"+tenantId);c.setDisableIdmEngine(true);
            engine=c.buildProcessEngine();
            if(initialize)engine.getRepositoryService().createDeployment().tenantId(tenantId).name("idms-maintenance-1.0.0").enableDuplicateFiltering().addClasspathResource("maintenance-v1.bpmn20.xml").deploy();
            ProcessDefinition definition=WorkflowStartup.definition(engine,tenantId);
            tenants.put(tenantId,new Tenant(engine,sql,new TransactionTemplate(tm),source,("Bearer "+a.serviceToken()).getBytes(StandardCharsets.UTF_8),definition.getId(),a.recoveryReadToken()==null?null:("Bearer "+a.recoveryReadToken()).getBytes(StandardCharsets.UTF_8),a.recoveryAuthorityId()));
            } catch(Exception failure) {
                if(engine!=null)engine.close();source.close();close();
                throw new IllegalStateException("WORKFLOW_EXISTING_DEPLOYMENT_REJECTED");
            }
        }
    }
    private Tenant authenticate(HttpServletRequest request){
        String tenantId=request.getHeader("X-IDMS-Tenant");Tenant tenant=tenants.get(tenantId);
        String supplied=request.getHeader("Authorization");
        if(tenant==null||supplied==null||!MessageDigest.isEqual(tenant.token(),supplied.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Invalid service identity");
        return tenant;
    }
    Tenant recoveryTenant(HttpServletRequest request){
        Tenant t=tenants.get(request.getHeader("X-IDMS-Tenant"));String supplied=request.getHeader("Authorization");
        if(t==null||t.recoveryToken()==null||supplied==null||!MessageDigest.isEqual(t.recoveryToken(),supplied.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Invalid recovery reader identity");
        if(Collections.list(request.getHeaders("Authorization")).size()!=1||Collections.list(request.getHeaders("X-IDMS-Tenant")).size()!=1)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Duplicate recovery identity");return t;
    }
    Map<String,Object> recoveryView(Tenant t,String id){return view(t,id);}
    @GetMapping("/health") Map<String,Object> health(){return Map.of("status","UP","engine","Flowable","version","7.2.0","process","idmsMaintenanceV1","tenantCount",tenants.size());}
    @GetMapping("/v1/status") Map<String,Object> status(HttpServletRequest request) throws Exception {Tenant t=authenticate(request);return Map.of("status","UP","engine","Flowable","version","7.2.0","definitionId",t.definitionId(),"activeProcesses",t.engine().getRuntimeService().createProcessInstanceQuery().count(),"startupContract",WorkflowStartup.CONTRACT,"startupMode",startupMode,"definitionVersion",WorkflowStartup.VERSION,"definitionDigest",WorkflowStartup.digest(WorkflowStartup.reviewedResource()));}
    @GetMapping("/v1/cases/{entityId}") Map<String,Object> details(HttpServletRequest request,@PathVariable String entityId){Tenant t=authenticate(request);return t.tx().execute(s->view(t,entityId));}
    @PostMapping("/v1/commands") Map<String,Object> command(HttpServletRequest request,@RequestBody JsonNode payload){
        Tenant t=authenticate(request);Command command=decode(payload);validate(command);
        return t.tx().execute(tx->{
            // Serialize every command of this business object, including first creation; receipt and engine share this transaction.
            t.sql().queryForObject("SELECT pg_advisory_xact_lock(hashtext(?)) IS NULL",Boolean.class,command.entityId());
            var prior=t.sql().queryForList("SELECT request_digest,response::text AS response FROM idms_workflow_commands WHERE command_id=?::uuid",command.commandId());
            if(!prior.isEmpty()){
                if(!prior.getFirst().get("request_digest").equals(command.requestDigest()))throw conflict("Idempotency digest conflict");
                try{return json.readValue((String)prior.getFirst().get("response"),Map.class);}catch(Exception e){throw new IllegalStateException("Invalid command receipt");}
            }
            apply(t,request.getHeader("X-IDMS-Tenant"),command);
            Map<String,Object> result=view(t,command.entityId());
            result.put("commandId",command.commandId());result.put("requestDigest",command.requestDigest());
            try{t.sql().update("INSERT INTO idms_workflow_commands(command_id,request_digest,response) VALUES(?::uuid,?,?::jsonb)",command.commandId(),command.requestDigest(),json.writeValueAsString(result));}catch(Exception e){throw new IllegalStateException("Command receipt persistence failed");}
            return result;
        });
    }
    private Command decode(JsonNode payload){
        try{
            if(!payload.isObject())throw new IllegalArgumentException();
            Set<String> allowed=Set.of("commandId","requestDigest","entityId","action","expectedVersion","actor","assignee","evidenceDigest","decision","comment","correlationId");
            payload.fieldNames().forEachRemaining(k->{if(!allowed.contains(k))throw new IllegalArgumentException();});
            ObjectNode unsigned=((ObjectNode)payload).deepCopy();unsigned.remove("requestDigest");
            String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical(unsigned).getBytes(StandardCharsets.UTF_8)));
            if(!hash.equals(payload.path("requestDigest").asText()))throw new IllegalArgumentException();
            return json.treeToValue(payload,Command.class);
        }catch(Exception e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid command schema or content digest");}
    }
    private String canonical(JsonNode node) throws Exception {
        if(node.isObject()){
            List<String> keys=new ArrayList<>();node.fieldNames().forEachRemaining(keys::add);Collections.sort(keys);
            List<String> members=new ArrayList<>();for(String key:keys)members.add(json.writeValueAsString(key)+":"+canonical(node.get(key)));
            return "{"+String.join(",",members)+"}";
        }
        if(node.isArray()){List<String> items=new ArrayList<>();for(JsonNode item:node)items.add(canonical(item));return "["+String.join(",",items)+"]";}
        return json.writeValueAsString(node);
    }
    private void validate(Command c){
        if(c.commandId()==null||!c.commandId().matches("[a-fA-F0-9-]{36}")||c.requestDigest()==null||!c.requestDigest().matches("[a-f0-9]{64}")||c.entityId()==null||!c.entityId().matches("[a-fA-F0-9-]{36}")||c.actor()==null||c.actor().id()==null||c.actor().id().isBlank()||c.actor().id().length()>200||c.actor().permissions()==null||!"USER".equals(c.actor().type())||c.expectedVersion()<1)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid command identity or actor");
        if(c.action()==null||!Set.of("create","claim","start","submit","approval").contains(c.action()))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unsupported command");
        String permission=c.action().equals("create")?"predictive:approve":c.action().equals("approval")?"maintenance:approve":"maintenance:execute";
        if(!c.actor().permissions().contains(permission))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Actor lacks permission");
        if(c.comment()!=null&&c.comment().length()>2000)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Comment too long");
    }
    private void apply(Tenant t,String tenantId,Command c){
        var rows=t.sql().queryForList("SELECT * FROM idms_workflow_cases WHERE entity_id=? FOR UPDATE",c.entityId());
        if(c.action().equals("create")){
            if(!rows.isEmpty())throw conflict("Business object already has a process");
            String assignee=c.assignee()==null?"":c.assignee();
            t.engine().getIdentityService().setAuthenticatedUserId(c.actor().id());
            try{
                var process=t.engine().getRuntimeService().createProcessInstanceBuilder().processDefinitionId(t.definitionId()).businessKey(c.entityId()).businessStatus("MAINTENANCE").tenantId(tenantId).variables(Map.of("assigned",!assignee.isBlank(),"assignee",assignee,"approved",false)).start();
                t.sql().update("INSERT INTO idms_workflow_cases(entity_id,process_id,version,state,assignee) VALUES(?,?,?,?,?)",c.entityId(),process.getId(),c.expectedVersion(),assignee.isBlank()?"UNASSIGNED":"ASSIGNED",assignee);
            }finally{t.engine().getIdentityService().setAuthenticatedUserId(null);}
            return;
        }
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Workflow case not found");
        var row=rows.getFirst();if(((Number)row.get("version")).intValue()!=c.expectedVersion())throw conflict("Workflow version changed");
        String processId=(String)row.get("process_id"),state=(String)row.get("state"),assignee=(String)row.get("assignee"),next;
        TaskService tasks=t.engine().getTaskService();Task task=tasks.createTaskQuery().processInstanceId(processId).singleResult();
        if(task==null)throw conflict("No active task");
        String required=switch(c.action()){case "claim"->"claim";case "start"->"startRepair";case "submit"->"repair";default->"finalApproval";};
        if(!task.getTaskDefinitionKey().equals(required))throw conflict("Unexpected BPMN task");
        Map<String,Object> variables=new HashMap<>();
        if(c.action().equals("claim")){
            if(!state.equals("UNASSIGNED"))throw conflict("Already assigned");assignee=c.actor().id();variables.put("assignee",assignee);next="ASSIGNED";
        }else if(c.action().equals("approval")){
            if(!state.equals("AWAITING_APPROVAL")||c.actor().id().equals(assignee)||c.actor().id().equals(row.get("submitted_by")))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Independent final human approval required");
            if(c.evidenceDigest()==null||!c.evidenceDigest().equals(row.get("evidence_digest")))throw conflict("Evidence digest mismatch");
            if(c.decision()==null||!Set.of("APPROVED","RETURNED").contains(c.decision())||c.comment()==null||c.comment().trim().length()<2)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid final decision");
            variables.put("approved",c.decision().equals("APPROVED"));next=c.decision().equals("APPROVED")?"CLOSED":"IN_PROGRESS";
        }else{
            if(!assignee.equals(c.actor().id()))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Only assigned engineer may execute");
            next=c.action().equals("start")?"IN_PROGRESS":"AWAITING_APPROVAL";
            if(c.action().equals("submit")){
                if(c.evidenceDigest()==null||!c.evidenceDigest().matches("[a-f0-9]{64}"))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Missing frozen repair evidence");
                t.sql().update("UPDATE idms_workflow_cases SET evidence_digest=?,submitted_by=? WHERE entity_id=?",c.evidenceDigest(),c.actor().id(),c.entityId());
            }
        }
        t.engine().getIdentityService().setAuthenticatedUserId(c.actor().id());
        try{tasks.setAssignee(task.getId(),c.actor().id());tasks.addComment(task.getId(),processId,c.action()+": "+(c.comment()==null?"":c.comment())+" / correlation="+c.correlationId()+" / evidence="+c.evidenceDigest());tasks.complete(task.getId(),variables);}finally{t.engine().getIdentityService().setAuthenticatedUserId(null);}
        t.sql().update("UPDATE idms_workflow_cases SET state=?,version=version+1,assignee=? WHERE entity_id=?",next,assignee,c.entityId());
    }
    private Map<String,Object> view(Tenant t,String id){
        var rows=t.sql().queryForList("SELECT * FROM idms_workflow_cases WHERE entity_id=?",id);if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Workflow case not found");
        var row=rows.getFirst();String processId=(String)row.get("process_id");
        var history=t.engine().getHistoryService().createHistoricProcessInstanceQuery().processInstanceId(processId).singleResult();
        var result=new LinkedHashMap<String,Object>();result.put("entityId",id);result.put("state",row.get("state"));result.put("version",row.get("version"));result.put("processInstanceId",processId);result.put("definitionId",history.getProcessDefinitionId());result.put("ended",history.getEndTime()!=null);
        result.put("tasks",t.engine().getTaskService().createTaskQuery().processInstanceId(processId).list().stream().map(task->Map.of("id",task.getId(),"key",task.getTaskDefinitionKey(),"name",task.getName(),"assignee",Objects.toString(task.getAssignee(),""))).toList());
        result.put("history",t.engine().getHistoryService().createHistoricTaskInstanceQuery().processInstanceId(processId).orderByHistoricTaskInstanceStartTime().asc().list().stream().map(task->Map.of("id",task.getId(),"key",task.getTaskDefinitionKey(),"assignee",Objects.toString(task.getAssignee(),""),"startedAt",Objects.toString(task.getStartTime(),""),"endedAt",Objects.toString(task.getEndTime(),""))).toList());
        return result;
    }
    private ResponseStatusException conflict(String message){return new ResponseStatusException(HttpStatus.CONFLICT,message);}
    @PreDestroy void close(){for(Tenant t:tenants.values()){t.engine().close();t.source().close();}}
}

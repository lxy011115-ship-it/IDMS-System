package com.idms.workflowreview;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.flowable.engine.repository.ProcessDefinition;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@RestController
public class RecoveryReadController {
    private final ReaderRegistry workflow;private final ObjectMapper json;
    RecoveryReadController(ReaderRegistry workflow,ObjectMapper json){this.workflow=workflow;this.json=json;}
    private void require(boolean ok){if(!ok)throw new ResponseStatusException(HttpStatus.CONFLICT,"Workflow recovery state is not supported or exceeds limits");}
    @GetMapping("/v1/recovery-state") Map<String,Object> snapshot(HttpServletRequest request){
        if(request.getQueryString()!=null)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Recovery query parameters are not supported");
        var t=workflow.recoveryTenant(request);var tx=new TransactionTemplate(t.tx().getTransactionManager());tx.setReadOnly(true);tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);tx.setTimeout(15);
        return tx.execute(status->{
            workflow.verify(t);var settings=t.sql().queryForMap("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation");require("on".equals(settings.get("readonly"))&&"repeatable read".equals(settings.get("isolation")));
            require(t.sql().queryForObject("SELECT count(*) FROM idms_workflow_cases",Long.class)<=512);
            require(!t.sql().queryForObject("SELECT EXISTS(SELECT 1 FROM idms_workflow_cases WHERE octet_length(entity_id)>128 OR octet_length(process_id)>256 OR octet_length(state)>80 OR octet_length(assignee)>256 OR octet_length(evidence_digest)>128 OR octet_length(submitted_by)>256)",Boolean.class));
            require(t.sql().queryForObject("SELECT count(*) FROM idms_workflow_commands",Long.class)<=8192);
            var engine=t.engine();require(engine.getHistoryService().createHistoricTaskInstanceQuery().count()<=16384);
            var histories=engine.getHistoryService().createHistoricProcessInstanceQuery().listPage(0,513);require(histories.size()<=512);
            var active=engine.getRuntimeService().createProcessInstanceQuery().listPage(0,513);require(active.size()<=512);
            var definition=engine.getRepositoryService().createProcessDefinitionQuery().processDefinitionKey("idmsMaintenanceV1").processDefinitionTenantId(request.getHeader("X-IDMS-Tenant")).latestVersion().singleResult();require(definition!=null&&!definition.isSuspended());
            Set<String> processIds=new HashSet<>(),activeIds=new HashSet<>();for(var p:histories)require(processIds.add(p.getId()));for(var p:active)require(activeIds.add(p.getId()));
            var rows=t.sql().queryForList("SELECT entity_id,process_id,version,state,assignee,evidence_digest,submitted_by FROM idms_workflow_cases ORDER BY entity_id COLLATE \"C\"");
            List<Map<String,Object>> cases=new ArrayList<>();Set<String> entityIds=new HashSet<>(),caseProcesses=new HashSet<>();Map<String,Object> definitions=new TreeMap<>();Map<String,com.fasterxml.jackson.databind.JsonNode> liveViews=new HashMap<>();Map<String,String> latestCommands=new HashMap<>();
            definitions.put(definition.getId(),describe(t,definition));
            for(var row:rows){String id=(String)row.get("entity_id"),process=(String)row.get("process_id");require(id!=null&&id.matches("[a-fA-F0-9-]{36}")&&entityIds.add(id)&&process!=null&&caseProcesses.add(process));
                var view=workflow.recoveryView(t,id);require(process.equals(view.get("processInstanceId"))&&activeIds.contains(process)==Boolean.FALSE.equals(view.get("ended")));
                String defId=(String)view.get("definitionId");if(!definitions.containsKey(defId)){var d=engine.getRepositoryService().createProcessDefinitionQuery().processDefinitionId(defId).singleResult();require(d!=null);definitions.put(defId,describe(t,d));}
                Map<String,Object> variables=variables(t,process,true);require(Objects.equals(variables.get("assignee"),row.get("assignee")));if(activeIds.contains(process))require(variables.equals(variables(t,process,false)));require(Objects.equals(variables.get("approved"),view.get("ended")));
                liveViews.put(id,json.valueToTree(view));Map<String,Object> item=new LinkedHashMap<>(view);item.put("assignee",row.get("assignee"));item.put("evidenceDigest",row.get("evidence_digest"));item.put("submittedBy",row.get("submitted_by"));item.put("variables",variables);cases.add(item);
            }require(caseProcesses.equals(processIds)&&caseProcesses.containsAll(activeIds));
            try{
                var digest=MessageDigest.getInstance("SHA-256");long[] measured={0,0};
                t.sql().query("SELECT command_id::text AS command_id,request_digest,response::text AS response,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at FROM idms_workflow_commands ORDER BY command_id::text COLLATE \"C\"",rs->{
                    try{String response=rs.getString("response");require(response.getBytes(StandardCharsets.UTF_8).length<=1048576);var body=json.readTree(response);require(entityIds.contains(body.path("entityId").asText())&&rs.getString("command_id").equals(body.path("commandId").asText())&&rs.getString("request_digest").equals(body.path("requestDigest").asText()));
                        String entity=body.path("entityId").asText();var live=liveViews.get(entity);if(body.path("version").asInt()==live.path("version").asInt()){require(!latestCommands.containsKey(entity));var fields=live.fieldNames();while(fields.hasNext()){String field=fields.next();require(live.get(field).equals(body.get(field)));}latestCommands.put(entity,rs.getString("command_id"));}
                        String line=json.writeValueAsString(List.of(rs.getString("command_id"),rs.getString("request_digest"),response,rs.getString("created_at")))+"\n";byte[] bytes=line.getBytes(StandardCharsets.UTF_8);measured[0]++;measured[1]+=bytes.length;require(measured[1]<=16*1024*1024);digest.update(bytes);
                    }catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Invalid recovery command ledger");}
                });
                require(latestCommands.keySet().equals(entityIds));for(var item:cases)item.put("lastCommandId",latestCommands.get((String)item.get("entityId")));
                Map<String,Object> result=new LinkedHashMap<>();result.put("format","idms-workflow-recovery-state-v1");result.put("tenantId",request.getHeader("X-IDMS-Tenant"));result.put("authorityId",t.recoveryAuthorityId());result.put("engine","Flowable");result.put("version","7.2.0");result.put("readOnly",true);result.put("isolation","repeatable read");result.put("latestDefinitionId",definition.getId());result.put("definitions",definitions);result.put("activeProcessIds",activeIds.stream().sorted().toList());result.put("cases",cases);result.put("commandCount",measured[0]);result.put("commandBytes",measured[1]);result.put("commandSha256",HexFormat.of().formatHex(digest.digest()));require(json.writeValueAsBytes(result).length<=3*1024*1024);return result;
            }catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Workflow recovery capture failed");}
        });
    }
    private Map<String,Object> describe(ReaderRegistry.Tenant t,ProcessDefinition d){
        require("idmsMaintenanceV1".equals(d.getKey())&&d.getVersion()==1&&!d.isSuspended());
        try(var in=t.engine().getRepositoryService().getResourceAsStream(d.getDeploymentId(),d.getResourceName())){byte[] bytes=in.readNBytes(262145);require(bytes.length<=262144);return Map.of("id",d.getId(),"key",d.getKey(),"version",d.getVersion(),"tenantId",d.getTenantId(),"bpmnSha256",bpmn(t,bytes));}catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Workflow definition unavailable");}
    }
    private String bpmn(ReaderRegistry.Tenant t,byte[] bytes) throws Exception {
        String digest=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));require(t.bpmnSha256().equals(digest));return digest;
    }
    @GetMapping("/health") Map<String,Object> health() { return Map.of("status","UP","engine","Flowable","version","7.2.0","mode","RECOVERY_READ_ONLY"); }
    private Map<String,Object> variables(ReaderRegistry.Tenant t,String process,boolean history){
        // The compiled v1 model only uses two booleans and one short string.
        // Never deserialize arbitrary engine values or byte-array attachments.
        String table=history?"act_hi_varinst":"act_ru_variable",type=history?"var_type_":"type_";
        var rows=t.sql().queryForList("SELECT name_,"+type+" AS kind,long_,double_,text_,text2_,bytearray_id_ FROM "+table+" WHERE proc_inst_id_=? LIMIT 4",process);require(rows.size()==3);Map<String,Object> values=new TreeMap<>();
        for(var v:rows){String name=(String)v.get("name_");require(name!=null&&!values.containsKey(name)&&Set.of("assigned","assignee","approved").contains(name)&&v.get("bytearray_id_")==null&&v.get("double_")==null&&v.get("text2_")==null);if(name.equals("assignee")){require("string".equals(v.get("kind"))&&v.get("long_")==null&&v.get("text_") instanceof String&&((String)v.get("text_")).getBytes(StandardCharsets.UTF_8).length<=256);values.put(name,v.get("text_"));}else{require("boolean".equals(v.get("kind"))&&v.get("text_")==null&&v.get("long_") instanceof Number);long value=((Number)v.get("long_")).longValue();require(value==0||value==1);values.put(name,value==1);}}return values;
    }
}

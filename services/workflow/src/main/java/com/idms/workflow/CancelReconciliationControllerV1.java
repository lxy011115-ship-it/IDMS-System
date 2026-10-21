package com.idms.workflow;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.core.JsonParser;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
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
import java.util.*;

/** Opt-in only. The old command controller and its transaction protocol remain unchanged. */
@RestController
public class CancelReconciliationControllerV1 {
    record Account(String jdbcUrl,String user,String password,String token,String authorityId,String databaseOid,String roleOid,String catalogHash) {}
    record Config(int format,Map<String,Account> tenants) {}
    record Tenant(Account account,HikariDataSource source,JdbcTemplate sql,TransactionTemplate tx,byte[] token) {}
    private final Map<String,Tenant> tenants=new HashMap<>();
    private final ObjectMapper json;
    private final String catalog;
    private static final String UUID="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
    CancelReconciliationControllerV1(ObjectMapper json) throws Exception {
        this.json=json;
        try(var in=getClass().getResourceAsStream("/workflow-cancel-catalog-v1.sql")){if(in==null)throw new IllegalStateException("Missing reconciliation catalog");catalog=new String(in.readAllBytes(),StandardCharsets.UTF_8);}
        String file=System.getenv("IDMS_WORKFLOW_CANCEL_CONFIG");
        if(file==null)return;
        try{
            if(Files.size(Path.of(file))>262144)throw new IllegalArgumentException();
            JsonNode raw=json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(Files.readString(Path.of(file)));keys(raw,Set.of("format","tenants"));
            String workflowFile=System.getenv("IDMS_WORKFLOW_CONFIG");
            if(workflowFile==null||Files.size(Path.of(workflowFile))>1048576)throw new IllegalArgumentException();
            JsonNode workflow=json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(Files.readString(Path.of(workflowFile)));
            Config config=json.treeToValue(raw,Config.class);
            if(config.format()!=1||config.tenants()==null||config.tenants().isEmpty()||config.tenants().size()>64)throw new IllegalArgumentException();
            for(var entry:config.tenants().entrySet()){
                String tenant=entry.getKey();Account a=entry.getValue();
                keys(raw.path("tenants").path(tenant),Set.of("jdbcUrl","user","password","token","authorityId","databaseOid","roleOid","catalogHash"));
                if(!tenant.matches("[a-z][a-z0-9_-]{0,63}")||a==null||a.jdbcUrl()==null||!a.jdbcUrl().matches("jdbc:postgresql://127\\.0\\.0\\.1:[0-9]{1,5}/[a-z0-9_]{1,63}")
                    ||a.user()==null||!a.user().matches("idms_[a-z0-9_]{1,58}")||a.password()==null||a.password().isEmpty()
                    ||a.token()==null||a.token().length()<32||a.token().length()>4096||a.token().contains("\n")||a.token().contains("\r")
                    ||a.authorityId()==null||!a.authorityId().matches(UUID)||a.databaseOid()==null||!a.databaseOid().matches("[1-9][0-9]*")
                    ||a.roleOid()==null||!a.roleOid().matches("[1-9][0-9]*")||a.catalogHash()==null||!a.catalogHash().matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
                JsonNode original=workflow.path("tenants").path(tenant);
                if(!a.jdbcUrl().equals(original.path("jdbcUrl").asText())||a.token().equals(original.path("serviceToken").asText())||a.user().equals(original.path("user").asText()))throw new IllegalArgumentException();
                HikariDataSource source=new HikariDataSource();source.setJdbcUrl(a.jdbcUrl());source.setUsername(a.user());source.setPassword(a.password());source.setMaximumPoolSize(2);source.setPoolName("cancel-reconcile-"+tenant);
                var sql=new JdbcTemplate(source);sql.setQueryTimeout(15);var tx=new TransactionTemplate(new DataSourceTransactionManager(source));tx.setTimeout(15);
                Tenant t=new Tenant(a,source,sql,tx,("Bearer "+a.token()).getBytes(StandardCharsets.UTF_8));tenants.put(tenant,t);check(t);
                t.sql().queryForObject("SELECT idms_workflow_cancel_v1.read_v1(?,?::uuid,?::uuid)::text",String.class,tenant,a.authorityId(),java.util.UUID.randomUUID().toString());
            }
        }catch(Exception e){close();throw new IllegalStateException("Invalid private cancellation reconciliation configuration");}
    }
    private static void keys(JsonNode value,Set<String> allowed){
        if(value==null||!value.isObject()||value.size()!=allowed.size())throw new IllegalArgumentException();
        value.fieldNames().forEachRemaining(k->{if(!allowed.contains(k))throw new IllegalArgumentException();});
    }
    private Tenant authenticate(HttpServletRequest request){
        if(tenants.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Cancellation reconciliation is not enabled");
        Tenant t=tenants.get(request.getHeader("X-IDMS-Tenant"));String supplied=request.getHeader("Authorization");
        if(t==null||supplied==null||!MessageDigest.isEqual(t.token(),supplied.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Invalid cancellation reconciliation identity");
        if(Collections.list(request.getHeaders("Authorization")).size()!=1||Collections.list(request.getHeaders("X-IDMS-Tenant")).size()!=1||request.getQueryString()!=null)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid cancellation reconciliation request");
        return t;
    }
    private void check(Tenant t){
        try{
            String manifest=t.sql().queryForObject(catalog,String.class);JsonNode value=json.readTree(manifest);
            String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(manifest.getBytes(StandardCharsets.UTF_8)));
            if(!hash.equals(t.account().catalogHash())||!t.account().databaseOid().equals(value.path("databaseOid").asText())||!t.account().roleOid().equals(value.path("roleOid").asText()))throw new IllegalArgumentException();
        }catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Cancellation reconciliation catalog changed");}
    }
    private JsonNode envelope(JsonNode value) throws Exception {
        keys(value,Set.of("commandId","entityId","action","expectedVersion","actor","assignee","correlationId","requestDigest"));
        keys(value.path("actor"),Set.of("id","type","permissions"));
        if(!value.path("commandId").isTextual()||!value.path("commandId").asText().matches(UUID)||!value.path("entityId").isTextual()||!value.path("entityId").asText().matches(UUID)
            ||!"create".equals(value.path("action").asText())||!value.path("expectedVersion").isIntegralNumber()||value.path("expectedVersion").asInt()!=1
            ||!value.path("requestDigest").isTextual()||!value.path("requestDigest").asText().matches("[a-f0-9]{64}")
            ||!value.path("actor").path("id").isTextual()||value.path("actor").path("id").asText().isBlank()||value.path("actor").path("id").asText().length()>200
            ||!"USER".equals(value.path("actor").path("type").asText())||!value.path("actor").path("permissions").isArray()||value.path("actor").path("permissions").size()>64
            ||!value.path("assignee").isTextual()||value.path("assignee").asText().length()>200
            ||!value.path("correlationId").isTextual()||value.path("correlationId").asText().isBlank()||value.path("correlationId").asText().length()>200)throw new IllegalArgumentException();
        boolean permitted=false;for(JsonNode permission:value.path("actor").path("permissions")){if(!permission.isTextual()||permission.asText().length()>80)throw new IllegalArgumentException();if("predictive:approve".equals(permission.asText()))permitted=true;}
        if(!permitted)throw new IllegalArgumentException();
        ObjectNode unsigned=((ObjectNode)value).deepCopy();unsigned.remove("requestDigest");
        String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical(unsigned).getBytes(StandardCharsets.UTF_8)));
        if(!hash.equals(value.path("requestDigest").asText()))throw new IllegalArgumentException();return value;
    }
    private String canonical(JsonNode node) throws Exception {
        if(node.isObject()){List<String> names=new ArrayList<>();node.fieldNames().forEachRemaining(names::add);Collections.sort(names);List<String> members=new ArrayList<>();for(String k:names)members.add(json.writeValueAsString(k)+":"+canonical(node.get(k)));return "{"+String.join(",",members)+"}";}
        if(node.isArray()){List<String> members=new ArrayList<>();for(JsonNode item:node)members.add(canonical(item));return "["+String.join(",",members)+"]";}
        return json.writeValueAsString(node);
    }
    private Map<String,Object> result(Tenant t,String value){
        if(value==null)throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Cancellation reconciliation decision not found");
        try{if(value.getBytes(StandardCharsets.UTF_8).length>256000)throw new IllegalArgumentException();Map<String,Object> body=json.readValue(value,Map.class);body.put("catalogHash",t.account().catalogHash());return body;}
        catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Invalid cancellation reconciliation decision");}
    }
    @PostMapping("/v1/cancel-reconciliations") Map<String,Object> decide(HttpServletRequest request){
        Tenant t=authenticate(request);String control;JsonNode original;
        try{
            if(request.getContentType()==null||!request.getContentType().matches("(?i)application/json(?:\\s*;\\s*charset=utf-8)?"))throw new IllegalArgumentException();
            byte[] bytes=request.getInputStream().readNBytes(16385);if(bytes.length>16384)throw new IllegalArgumentException();JsonNode raw=json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);keys(raw,Set.of("controlId","envelope"));
            control=raw.path("controlId").asText();if(!control.matches(UUID))throw new IllegalArgumentException();original=envelope(raw.path("envelope"));
        }catch(Exception e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid cancellation reconciliation input");}
        try{return t.tx().execute(tx->{check(t);t.sql().execute("SET LOCAL lock_timeout='5s'");String value=t.sql().queryForObject("SELECT idms_workflow_cancel_v1.decide_v1(?,?::uuid,?::uuid,?::jsonb)::text",String.class,request.getHeader("X-IDMS-Tenant"),t.account().authorityId(),control,original.toString());check(t);return result(t,value);});}
        catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Cancellation reconciliation could not be confirmed");}
    }
    @GetMapping("/v1/cancel-reconciliations/{controlId}") Map<String,Object> read(HttpServletRequest request,@PathVariable String controlId){
        Tenant t=authenticate(request);if(!controlId.matches(UUID))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid cancellation reconciliation identifier");
        var tx=new TransactionTemplate(t.tx().getTransactionManager());tx.setReadOnly(true);tx.setTimeout(15);
        try{return tx.execute(status->{check(t);String value=t.sql().queryForObject("SELECT idms_workflow_cancel_v1.read_v1(?,?::uuid,?::uuid)::text",String.class,request.getHeader("X-IDMS-Tenant"),t.account().authorityId(),controlId);check(t);return result(t,value);});}
        catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Cancellation reconciliation query unavailable");}
    }
    @PreDestroy void close(){for(Tenant t:tenants.values())t.source().close();tenants.clear();}
}

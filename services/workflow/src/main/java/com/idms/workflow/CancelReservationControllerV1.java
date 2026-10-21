package com.idms.workflow;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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

@RestController
public class CancelReservationControllerV1 {
    record Account(String jdbcUrl,String user,String password,String token,String authorityId,String databaseOid,String roleOid,String catalogHash,String baseCatalogHash) {}
    record Config(int format,Map<String,Account> tenants) {}
    record Tenant(Account account,HikariDataSource source,JdbcTemplate sql,TransactionTemplate tx,byte[] token) {}
    private final Map<String,Tenant> tenants=new HashMap<>();private final ObjectMapper json;private final String catalog;
    private static final String UUID="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
    CancelReservationControllerV1(ObjectMapper json,CancelReconciliationControllerV1 baseController) throws Exception {
        this.json=json;
        try(var base=getClass().getResourceAsStream("/workflow-cancel-catalog-v1.sql");var extension=getClass().getResourceAsStream("/workflow-cancel-reservation-catalog-v1.sql")){
            if(base==null||extension==null)throw new IllegalStateException("Missing reservation catalog");
            catalog=new String(extension.readAllBytes(),StandardCharsets.UTF_8).replace("__BASE_CATALOG__",new String(base.readAllBytes(),StandardCharsets.UTF_8).trim());
        }
        String file=System.getenv("IDMS_WORKFLOW_CANCEL_RESERVATION_CONFIG");if(file==null)return;
        try{
            JsonNode raw=privateJson(file),old=privateJson(System.getenv("IDMS_WORKFLOW_CANCEL_CONFIG"));keys(raw,Set.of("format","tenants"));Config config=json.treeToValue(raw,Config.class);
            if(config.format()!=1||config.tenants()==null||config.tenants().isEmpty()||config.tenants().size()>64)throw new IllegalArgumentException();
            for(var entry:config.tenants().entrySet()){
                String id=entry.getKey();Account a=entry.getValue();JsonNode source=raw.path("tenants").path(id),prior=old.path("tenants").path(id);
                keys(source,Set.of("jdbcUrl","user","password","token","authorityId","databaseOid","roleOid","catalogHash","baseCatalogHash"));
                if(!id.matches("[a-z][a-z0-9_-]{0,63}")||a==null||a.catalogHash()==null||!a.catalogHash().matches("[a-f0-9]{64}")||a.baseCatalogHash()==null||!a.baseCatalogHash().equals(prior.path("catalogHash").asText()))throw new IllegalArgumentException();
                for(String key:List.of("jdbcUrl","user","password","token","authorityId","databaseOid","roleOid"))if(!source.path(key).isTextual()||!source.path(key).equals(prior.path(key)))throw new IllegalArgumentException();
                HikariDataSource ds=new HikariDataSource();ds.setJdbcUrl(a.jdbcUrl());ds.setUsername(a.user());ds.setPassword(a.password());ds.setMaximumPoolSize(2);ds.setPoolName("cancel-reservation-"+id);
                JdbcTemplate sql=new JdbcTemplate(ds);sql.setQueryTimeout(15);TransactionTemplate tx=new TransactionTemplate(new DataSourceTransactionManager(ds));tx.setTimeout(15);Tenant t=new Tenant(a,ds,sql,tx,("Bearer "+a.token()).getBytes(StandardCharsets.UTF_8));tenants.put(id,t);check(t);
                sql.queryForObject("SELECT idms_workflow_reservation_v1.read_v1(?,?::uuid,?::uuid)::text",String.class,id,a.authorityId(),java.util.UUID.randomUUID().toString());
            }
        }catch(Exception e){close();throw new IllegalStateException("Invalid private workflow reservation configuration");}
    }
    private JsonNode privateJson(String file)throws Exception{if(file==null||Files.size(Path.of(file))>1048576)throw new IllegalArgumentException();return json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(Files.readString(Path.of(file)));}
    private static void keys(JsonNode value,Set<String> allowed){if(value==null||!value.isObject()||value.size()!=allowed.size())throw new IllegalArgumentException();value.fieldNames().forEachRemaining(k->{if(!allowed.contains(k))throw new IllegalArgumentException();});}
    private String hash(String value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}
    private void check(Tenant t){try{String manifest=t.sql().queryForObject(catalog,String.class);if(manifest==null||manifest.getBytes(StandardCharsets.UTF_8).length>512000)throw new IllegalArgumentException();JsonNode value=json.readTree(manifest),base=json.readTree(value.path("baseManifest").asText());if(!hash(manifest).equals(t.account().catalogHash())||!hash(value.path("baseManifest").asText()).equals(t.account().baseCatalogHash())||!base.path("databaseOid").asText().equals(t.account().databaseOid())||!base.path("roleOid").asText().equals(t.account().roleOid()))throw new IllegalArgumentException();}catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Workflow reservation catalog changed");}}
    private Tenant authenticate(HttpServletRequest req){if(tenants.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Workflow reservation is not enabled");Tenant t=tenants.get(req.getHeader("X-IDMS-Tenant"));String token=req.getHeader("Authorization");if(t==null||token==null||!MessageDigest.isEqual(t.token(),token.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Invalid workflow reservation identity");if(Collections.list(req.getHeaders("Authorization")).size()!=1||Collections.list(req.getHeaders("X-IDMS-Tenant")).size()!=1||req.getQueryString()!=null)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid workflow reservation request");return t;}
    private String canonical(JsonNode node)throws Exception{if(node.isObject()){List<String> names=new ArrayList<>();node.fieldNames().forEachRemaining(names::add);Collections.sort(names);List<String> parts=new ArrayList<>();for(String k:names)parts.add(json.writeValueAsString(k)+":"+canonical(node.get(k)));return "{"+String.join(",",parts)+"}";}if(node.isArray()){List<String> parts=new ArrayList<>();for(JsonNode v:node)parts.add(canonical(v));return "["+String.join(",",parts)+"]";}return json.writeValueAsString(node);}
    private JsonNode envelope(JsonNode e)throws Exception{
        keys(e,Set.of("commandId","entityId","action","expectedVersion","actor","assignee","correlationId","requestDigest"));keys(e.path("actor"),Set.of("id","type","permissions"));
        if(!e.path("commandId").isTextual()||!e.path("commandId").asText().matches(UUID)||!e.path("entityId").isTextual()||!e.path("entityId").asText().matches(UUID)||!"create".equals(e.path("action").asText())||!e.path("expectedVersion").isIntegralNumber()||!e.path("expectedVersion").asText().equals("1")||!e.path("assignee").isTextual()||e.path("assignee").asText().length()>200||!e.path("correlationId").isTextual()||e.path("correlationId").asText().isBlank()||e.path("correlationId").asText().length()>200||!e.path("requestDigest").isTextual()||!e.path("requestDigest").asText().matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
        JsonNode actor=e.path("actor");if(!actor.path("id").isTextual()||actor.path("id").asText().isBlank()||actor.path("id").asText().length()>200||!"USER".equals(actor.path("type").asText())||!actor.path("permissions").isArray()||actor.path("permissions").size()>64)throw new IllegalArgumentException();boolean allowed=false;for(JsonNode p:actor.path("permissions")){if(!p.isTextual()||p.asText().length()>80)throw new IllegalArgumentException();if(p.asText().equals("predictive:approve"))allowed=true;}if(!allowed)throw new IllegalArgumentException();
        ObjectNode unsigned=((ObjectNode)e).deepCopy();unsigned.remove("requestDigest");if(!hash(canonical(unsigned)).equals(e.path("requestDigest").asText()))throw new IllegalArgumentException();return e;
    }
    private Map<String,Object> result(Tenant t,String value){if(value==null)throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Workflow reservation not found");try{if(value.getBytes(StandardCharsets.UTF_8).length>256000)throw new IllegalArgumentException();Map<String,Object> body=json.readValue(value,Map.class);body.put("catalogHash",t.account().catalogHash());return body;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Invalid workflow reservation result");}}
    @PostMapping("/v1/cancel-reservations/{controlId}/{action}") Map<String,Object> change(HttpServletRequest req,@PathVariable String controlId,@PathVariable String action){
        Tenant t=authenticate(req);JsonNode original;String receipt=null;
        try{if(!controlId.matches(UUID)||!Set.of("reserve","release").contains(action)||req.getContentType()==null||!req.getContentType().matches("(?i)application/json(?:\\s*;\\s*charset=utf-8)?"))throw new IllegalArgumentException();byte[] bytes=req.getInputStream().readNBytes(16385);if(bytes.length>16384)throw new IllegalArgumentException();JsonNode body=json.reader().with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);keys(body,action.equals("reserve")?Set.of("envelope"):Set.of("envelope","domainReceiptDigest"));original=envelope(body.path("envelope"));if(action.equals("release")){receipt=body.path("domainReceiptDigest").asText();if(!receipt.matches("[a-f0-9]{64}"))throw new IllegalArgumentException();}}catch(Exception e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid workflow reservation input");}
        final String releaseDigest=receipt;
        try{return t.tx().execute(tx->{check(t);t.sql().execute("SET LOCAL lock_timeout='5s'");String value=action.equals("reserve")?t.sql().queryForObject("SELECT idms_workflow_reservation_v1.reserve_v1(?,?::uuid,?::uuid,?::jsonb)::text",String.class,req.getHeader("X-IDMS-Tenant"),t.account().authorityId(),controlId,original.toString()):t.sql().queryForObject("SELECT idms_workflow_reservation_v1.release_v1(?,?::uuid,?::uuid,?::jsonb,?)::text",String.class,req.getHeader("X-IDMS-Tenant"),t.account().authorityId(),controlId,original.toString(),releaseDigest);check(t);return result(t,value);});}catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.CONFLICT,"Workflow reservation operation unconfirmed");}
    }
    @GetMapping("/v1/cancel-reservations/{controlId}") Map<String,Object> read(HttpServletRequest req,@PathVariable String controlId){Tenant t=authenticate(req);if(!controlId.matches(UUID))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid workflow reservation identifier");TransactionTemplate tx=new TransactionTemplate(t.tx().getTransactionManager());tx.setReadOnly(true);tx.setTimeout(15);try{return tx.execute(status->{check(t);String value=t.sql().queryForObject("SELECT idms_workflow_reservation_v1.read_v1(?,?::uuid,?::uuid)::text",String.class,req.getHeader("X-IDMS-Tenant"),t.account().authorityId(),controlId);check(t);return result(t,value);});}catch(ResponseStatusException e){throw e;}catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Workflow reservation query unavailable");}}
    @PreDestroy void close(){for(Tenant t:tenants.values())t.source().close();tenants.clear();}
}

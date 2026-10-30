package com.idms.workflowreview;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.lang.management.ManagementFactory;
import java.util.*;
import java.util.concurrent.*;
import javax.management.ObjectName;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Holds the original Spring/Hikari connections in their original worker threads.
 * A reply timeout never cancels a worker or proves that its SQL transaction ended.
 */
@Component
public class OwnedReaderPeers implements OwnedReaderPeersMBean {
    private static final ObjectName NAME;
    static {try{NAME=new ObjectName("com.idms.workflowreview:type=OwnedReaderPeers");}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    private static final int MAX_LEASES=64;
    private final ReaderRegistry registry;private final RecoveryCapture capture;private final ObjectMapper json;
    private final Map<String,Lease> leases=new LinkedHashMap<>();
    private final ReaderPeerReplyBudget replies=new ReaderPeerReplyBudget();
    private Lease current;private boolean closing;
    private static void need(boolean ok,String code){if(!ok)throw new IllegalStateException(code);}
    private static boolean uuid(String s){return s!=null&&s.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}");}
    OwnedReaderPeers(ReaderRegistry registry,RecoveryCapture capture,ObjectMapper json){this.registry=registry;this.capture=capture;this.json=json.copy().enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION);}
    @PostConstruct void register() throws Exception {
        need(uuid(System.getProperty("idms.lifecycle.owner"))&&System.getProperty("idms.lifecycle.deployment","").matches("[a-f0-9]{64}"),"READER_PEER_OWNED_LAUNCH_REQUIRED");
        ManagementFactory.getPlatformMBeanServer().registerMBean(this,NAME);
    }
    private void originalConfiguration(){registry.verifyConfiguration();need(System.getProperty("idms.lifecycle.stop-request")==null&&!closing,"READER_PEER_STOPPING");}
    @Override public synchronized String exchange(String request) throws Exception {
        need(request!=null&&request.length()<=1024,"READER_PEER_REQUEST");
        var n=json.readTree(request);need(n.isObject()&&n.size()==5,"READER_PEER_REQUEST");
        Set<String> fields=new HashSet<>();n.fieldNames().forEachRemaining(fields::add);
        need(fields.equals(Set.of("format","operation","leaseId","requestId","tenantId")),"READER_PEER_REQUEST");
        for(String f:fields)need(n.get(f).isTextual(),"READER_PEER_REQUEST");
        String op=n.get("operation").asText(),id=n.get("leaseId").asText(),req=n.get("requestId").asText(),tenant=n.get("tenantId").asText();
        need("IDMS_OWNED_READER_PEER_REQUEST_V1".equals(n.get("format").asText())&&uuid(id)&&uuid(req)&&Set.of("ACQUIRE","PROBE","CAPTURE","RELEASE").contains(op),"READER_PEER_REQUEST");
        need(op.equals("CAPTURE")?registry.registeredTenants().containsKey(tenant):tenant.equals("-"),"READER_PEER_TENANT");
        originalConfiguration();
        var cached=replies.lookup(req,request);
        if(cached!=null)return cached;
        try(var admission=replies.begin(req,request,op,id)){
        Lease lease=leases.get(id);Map<String,Object> result;
        if(op.equals("ACQUIRE")){
            if(lease==null){
                need(current==null&&leases.size()<MAX_LEASES,"READER_PEER_OTHER_LEASE");
                lease=new Lease(id);leases.put(id,lease);current=lease;
                // Save the original lease before attempting to drain or borrow.
                lease.start();
            }
            need(lease==current&&!lease.releaseRequested,"READER_PEER_LEASE_NOT_HELD");
            result=lease.probe();
        }else if(op.equals("RELEASE")){
            if(lease==null){
                // Preserve the tombstone, so a delayed acquire cannot resurrect it.
                need(current==null&&leases.size()<MAX_LEASES,"READER_PEER_OTHER_LEASE");
                lease=new Lease(id);leases.put(id,lease);
            }
            result=lease.release();
        }else{
            need(lease!=null&&lease==current&&!lease.releaseRequested,"READER_PEER_LEASE_NOT_HELD");
            result=op.equals("PROBE")?lease.probe():lease.capture(tenant);
        }
        originalConfiguration();
        Map<String,Object> envelope=new LinkedHashMap<>();envelope.put("format","IDMS_OWNED_READER_PEER_REPLY_V1");envelope.put("operation",op);envelope.put("leaseId",id);envelope.put("requestId",req);envelope.put("tenantId",tenant);envelope.put("configSha256",registry.configSha256);envelope.put("result",result);
        String output=json.writeValueAsString(envelope);need(output.getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=4*1024*1024,"READER_PEER_REPLY_BUDGET");
        admission.complete(output);return output;
        }
    }
    private final class Lease {
        final String id;final List<Worker> workers=new ArrayList<>();long gate;
        volatile boolean releaseRequested;volatile long deadline=System.nanoTime()+TimeUnit.MINUTES.toNanos(5);
        boolean released;List<Map<String,Object>> originalIdentities=List.of();
        Lease(String id){this.id=id;}
        void start() throws Exception {
            gate=registry.acquireHttpGate();
            for(var t:registry.registeredTenants().values())need(t.source().getMaximumPoolSize()==2&&t.source().getMinimumIdle()==0,"READER_PEER_POOL_PROFILE");
            for(var e:registry.registeredTenants().entrySet()){
                var t=e.getValue();
                for(int slot=0;slot<2;slot++)workers.add(new Worker(this,e.getKey(),slot,t));
            }
            for(Worker w:workers){w.thread.start();w.started=true;}
            List<Map<String,Object>> ids=new ArrayList<>();for(Worker w:workers)ids.add(w.ready.get(25,TimeUnit.SECONDS));
            need(ids.stream().map(v->v.get("pid")).distinct().count()==workers.size(),"READER_PEER_DUPLICATE_BACKEND");
            originalIdentities=List.copyOf(ids);
        }
        void live(){need(!releaseRequested&&!released&&System.nanoTime()<deadline,"READER_PEER_LEASE_EXPIRED_OR_RELEASED");deadline=System.nanoTime()+TimeUnit.MINUTES.toNanos(5);}
        List<Map<String,Object>> identities() throws Exception {
            live();List<Map<String,Object>> ids=new ArrayList<>();
            for(Worker w:workers)ids.add(w.command(false).get(20,TimeUnit.SECONDS));
            need(ids.equals(originalIdentities)&&workers.size()==2*registry.registeredTenants().size(),"READER_PEER_BACKEND_CHANGED");
            for(var t:registry.registeredTenants().values()){var p=t.source().getHikariPoolMXBean();need(p!=null&&p.getActiveConnections()==2&&p.getIdleConnections()==0&&p.getTotalConnections()==2,"READER_PEER_POOL_NOT_FULLY_HELD");}
            return ids;
        }
        Map<String,Object> probe() throws Exception {return Map.of("phase","HELD","connections",identities(),"allPoolSlotsHeld",true,"httpReadsDrained",true);}
        Map<String,Object> capture(String tenant) throws Exception {
            var before=identities();Worker w=workers.stream().filter(a->a.tenant.equals(tenant)&&a.slot==0).findFirst().orElseThrow();
            var result=w.command(true).get(25,TimeUnit.SECONDS);need(before.equals(identities()),"READER_PEER_BACKEND_CHANGED");
            return Map.of("phase","HELD","connections",before,"snapshot",result,"sameOriginalTransaction",true);
        }
        Map<String,Object> release() throws Exception {
            if(released)return releaseView();
            releaseRequested=true;
            // No cancellation, interrupt, PID-based stop or termination query.
            for(Worker w:workers)if(w.started)w.done.get(30,TimeUnit.SECONDS);
            for(Worker w:workers)if(w.started){w.thread.join(1000);need(!w.thread.isAlive()&&(!w.transactionEntered||w.rolledBack),"READER_PEER_ROLLBACK_UNCONFIRMED");}
            if(gate!=0){
                for(var t:registry.registeredTenants().values())t.source().getHikariPoolMXBean().softEvictConnections();
                long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
                boolean empty;
                do{empty=true;for(var t:registry.registeredTenants().values()){var p=t.source().getHikariPoolMXBean();empty&=p.getActiveConnections()==0&&p.getIdleConnections()==0&&p.getTotalConnections()==0;}if(!empty)Thread.sleep(20);}while(!empty&&System.nanoTime()<end);
                need(empty,"READER_PEER_POOL_RETIREMENT_UNCONFIRMED");
                registry.releaseHttpGate(gate);gate=0;
            }
            released=true;if(current==this)current=null;return releaseView();
        }
        Map<String,Object> releaseView(){return Map.of("phase","RELEASED","connections",originalIdentities,"allOriginalTransactionsRolledBack",true,"allOriginalPoolConnectionsRetired",true,"httpReadsResumed",true);}
    }
    private record Command(boolean capture,CompletableFuture<Map<String,Object>> reply){}
    private final class Worker {
        final Lease lease;final String tenant;final int slot;final ReaderRegistry.Tenant account;
        final BlockingQueue<Command> commands=new LinkedBlockingQueue<>(2);
        final CompletableFuture<Map<String,Object>> ready=new CompletableFuture<>();
        final CompletableFuture<Void> done=new CompletableFuture<>();
        final Thread thread;volatile boolean rolledBack,started,transactionEntered;
        Worker(Lease lease,String tenant,int slot,ReaderRegistry.Tenant account){this.lease=lease;this.tenant=tenant;this.slot=slot;this.account=account;thread=new Thread(this::run,"idms-owned-reader-"+tenant+"-"+slot+"-"+lease.id);}
        Map<String,Object> identity(){
            registry.verify(account);
            var r=account.sql().queryForMap("SELECT pg_backend_pid() AS pid,to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS \"backendStart\",a.datid::text AS \"databaseOid\",a.usesysid::text AS \"roleOid\",current_database() AS database,current_user AS \"currentUser\",session_user AS \"sessionUser\",host(inet_server_addr()) AS host,inet_server_port() AS port,to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS \"postmasterStart\",current_setting('transaction_read_only') AS \"readOnly\",current_setting('transaction_isolation') AS isolation FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()");
            need(account.databaseOid().equals(r.get("databaseOid"))&&account.roleOid().equals(r.get("roleOid"))&&account.database().equals(r.get("database"))&&account.user().equals(r.get("currentUser"))&&account.user().equals(r.get("sessionUser"))&&"on".equals(r.get("readOnly"))&&"repeatable read".equals(r.get("isolation")),"READER_PEER_SQL_IDENTITY");
            var out=new LinkedHashMap<String,Object>(r);out.put("tenantId",tenant);out.put("slot",slot);return Collections.unmodifiableMap(out);
        }
        CompletableFuture<Map<String,Object>> command(boolean capture){
            need(!done.isDone()&&ready.isDone()&&!ready.isCompletedExceptionally(),"READER_PEER_WORKER_NOT_LIVE");
            var c=new Command(capture,new CompletableFuture<>());need(commands.offer(c),"READER_PEER_WORKER_BUSY");return c.reply;
        }
        void run(){
            try{
                var tx=new TransactionTemplate(account.tx().getTransactionManager());tx.setReadOnly(true);tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
                tx.execute(status->{
                    transactionEntered=true;
                    org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(new org.springframework.transaction.support.TransactionSynchronization(){
                        @Override public void afterCompletion(int completion){rolledBack=completion==STATUS_ROLLED_BACK;}
                    });
                    status.setRollbackOnly();var first=identity();ready.complete(first);
                    try{
                        while(!lease.releaseRequested&&System.nanoTime()<lease.deadline){
                            var c=commands.poll(200,TimeUnit.MILLISECONDS);if(c==null)continue;
                            try{need(first.equals(identity()),"READER_PEER_BACKEND_CHANGED");var result=c.capture?capture.capture(account,tenant):first;need(first.equals(identity()),"READER_PEER_BACKEND_CHANGED");c.reply.complete(result);}
                            catch(RuntimeException|Error e){c.reply.completeExceptionally(e);throw e;}
                        }
                    }catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException("READER_PEER_WORKER_INTERRUPTED",e);}
                    return null;
                });
                need(rolledBack,"READER_PEER_ROLLBACK_UNCONFIRMED");done.complete(null);
            }catch(Throwable e){ready.completeExceptionally(e);if(!transactionEntered||rolledBack)done.complete(null);else done.completeExceptionally(e);}
            finally{Command c;while((c=commands.poll())!=null)c.reply.completeExceptionally(new IllegalStateException("READER_PEER_WORKER_RETIRED"));}
        }
    }
    @PreDestroy synchronized void close() throws Exception {
        closing=true;
        if(current!=null)current.release();
        var s=ManagementFactory.getPlatformMBeanServer();if(s.isRegistered(NAME))s.unregisterMBean(NAME);
    }
}

package com.idms.workflowreview;

import java.nio.charset.StandardCharsets;
import java.util.*;

/** Complete bounded replay history with one separate first-release slot per lease. */
final class ReaderPeerReplyBudget {
    static final int NORMAL_REQUESTS=4096,RELEASE_LEASES=64;
    static final int NORMAL_REPLY_BYTES=4*1024*1024,RELEASE_REPLY_BYTES=256*1024,INPUT_BYTES=4096;
    static final long NORMAL_BYTES=64L*1024*1024,RELEASE_BYTES=(long)RELEASE_LEASES*(INPUT_BYTES+RELEASE_REPLY_BYTES);
    private record Reply(String input,String output){}
    private final Map<String,Reply> replies=new LinkedHashMap<>();
    private final Set<String> releasedLeases=new HashSet<>();
    private int normalCount;private long normalBytes,releaseBytes;private Admission pending;
    private static void need(boolean ok,String code){if(!ok)throw new IllegalStateException(code);}
    private static int bytes(String value){return value.getBytes(StandardCharsets.UTF_8).length;}

    synchronized String lookup(String id,String input){
        var reply=replies.get(id);if(reply==null)return null;
        need(reply.input().equals(input),"READER_PEER_REQUEST_REBOUND");return reply.output();
    }
    synchronized Admission begin(String id,String input,String operation,String leaseId){
        need(pending==null,"READER_PEER_REPLY_BUDGET_BUSY");
        need(id!=null&&input!=null&&leaseId!=null&&bytes(input)<=INPUT_BYTES&&!replies.containsKey(id),"READER_PEER_REPLY_BUDGET_INPUT");
        // A first RELEASE for any of the service's at most64 leases cannot be
        // crowded out by probes/captures or repeated releases of earlier leases.
        boolean reserved=operation.equals("RELEASE")&&!releasedLeases.contains(leaseId);
        if(reserved)need(releasedLeases.size()<RELEASE_LEASES&&releaseBytes+INPUT_BYTES+RELEASE_REPLY_BYTES<=RELEASE_BYTES,"READER_PEER_RELEASE_REPLY_BUDGET");
        else need(normalCount<NORMAL_REQUESTS&&normalBytes+INPUT_BYTES+NORMAL_REPLY_BYTES<=NORMAL_BYTES,"READER_PEER_REQUEST_BUDGET");
        pending=new Admission(id,input,leaseId,reserved);return pending;
    }
    final class Admission implements AutoCloseable {
        private final String id,input,leaseId;private final boolean reserved;private boolean closed;
        private Admission(String id,String input,String leaseId,boolean reserved){this.id=id;this.input=input;this.leaseId=leaseId;this.reserved=reserved;}
        void complete(String output){synchronized(ReaderPeerReplyBudget.this){
            need(!closed&&pending==this&&output!=null,"READER_PEER_REPLY_BUDGET_ADMISSION");
            int size=bytes(output);need(size<=(reserved?RELEASE_REPLY_BYTES:NORMAL_REPLY_BYTES),"READER_PEER_REPLY_BUDGET");
            long cost=(long)bytes(input)+size;
            need(!replies.containsKey(id),"READER_PEER_REQUEST_REBOUND");
            replies.put(id,new Reply(input,output));
            if(reserved){releaseBytes+=cost;releasedLeases.add(leaseId);}else{normalBytes+=cost;normalCount++;}
            closed=true;pending=null;
        }}
        @Override public void close(){synchronized(ReaderPeerReplyBudget.this){if(!closed){need(pending==this,"READER_PEER_REPLY_BUDGET_ADMISSION");closed=true;pending=null;}}}
    }
}

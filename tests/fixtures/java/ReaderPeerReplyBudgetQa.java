package com.idms.workflowreview;

/** Actual JVM contract checks only; no claim of OIDC, Flowable or live SQL here. */
public final class ReaderPeerReplyBudgetQa {
    private static int checks;
    private static void need(boolean v){if(!v)throw new AssertionError();checks++;}
    private static void deny(Runnable r,String code){try{r.run();throw new AssertionError("accepted");}catch(IllegalStateException e){need(e.getMessage().equals(code));}}
    private static void add(ReaderPeerReplyBudget b,String id,String input,String op,String lease,String output){try(var a=b.begin(id,input,op,lease)){a.complete(output);}}
    public static void main(String[] args){
        var b=new ReaderPeerReplyBudget();
        for(int n=0;n<4096;n++)add(b,"request-"+n,"probe-"+n,"PROBE","lease-a","ok-"+n);
        need("ok-0".equals(b.lookup("request-0","probe-0"))&&"ok-4095".equals(b.lookup("request-4095","probe-4095")));
        deny(()->b.begin("overflow","probe","PROBE","lease-a"),"READER_PEER_REQUEST_BUDGET");
        // All64 first releases still fit after the ordinary request count is full.
        for(int n=0;n<64;n++)add(b,"release-"+n,"release-input-"+n,"RELEASE","lease-"+n,"released-"+n);
        need("released-0".equals(b.lookup("release-0","release-input-0"))&&"released-63".equals(b.lookup("release-63","release-input-63")));
        deny(()->b.begin("lease65","release","RELEASE","lease-64"),"READER_PEER_RELEASE_REPLY_BUDGET");
        deny(()->b.begin("repeat-new-id","release","RELEASE","lease-0"),"READER_PEER_REQUEST_BUDGET");
        deny(()->b.lookup("release-0","different-lease-or-operation"),"READER_PEER_REQUEST_REBOUND");
        deny(()->b.lookup("request-0","changed"),"READER_PEER_REQUEST_REBOUND");
        // Closing a failed operation releases its admission without a phantom reply.
        var rollback=new ReaderPeerReplyBudget();try(var ignored=rollback.begin("a","input","RELEASE","lease")){}
        need(rollback.lookup("a","input")==null);add(rollback,"a","input","RELEASE","lease","released");
        try(var a=rollback.begin("oversize","input","PROBE","lease")){deny(()->a.complete("x".repeat(ReaderPeerReplyBudget.NORMAL_REPLY_BYTES+1)),"READER_PEER_REPLY_BUDGET");}
        need(rollback.lookup("oversize","input")==null);add(rollback,"oversize","input","PROBE","lease","small");
        // Byte exhaustion occurs before the next action, retaining every old reply.
        var bytes=new ReaderPeerReplyBudget();String large="x".repeat(ReaderPeerReplyBudget.NORMAL_REPLY_BYTES);int accepted=0;
        for(;;){try{add(bytes,"large-"+accepted,"input","CAPTURE","lease",large);accepted++;}catch(IllegalStateException e){need(e.getMessage().equals("READER_PEER_REQUEST_BUDGET"));break;}}
        need(accepted==15&&large.equals(bytes.lookup("large-0","input"))&&large.equals(bytes.lookup("large-14","input")));
        add(bytes,"release","release","RELEASE","lease","released");need("released".equals(bytes.lookup("release","release")));
        var busy=new ReaderPeerReplyBudget();try(var a=busy.begin("one","input","PROBE","lease")){deny(()->busy.begin("two","input","PROBE","lease"),"READER_PEER_REPLY_BUDGET_BUSY");a.complete("one");deny(()->a.complete("two"),"READER_PEER_REPLY_BUDGET_ADMISSION");}
        var reservedBytes=new ReaderPeerReplyBudget();String maxInput="i".repeat(ReaderPeerReplyBudget.INPUT_BYTES),maxRelease="r".repeat(ReaderPeerReplyBudget.RELEASE_REPLY_BYTES);
        for(int n=0;n<64;n++)add(reservedBytes,"reserved-"+n,maxInput,"RELEASE","lease-"+n,maxRelease);
        need(maxRelease.equals(reservedBytes.lookup("reserved-63",maxInput)));
        if(checks!=16)throw new AssertionError("check count "+checks);System.out.println("{\"format\":\"READER_PEER_REPLY_BUDGET_JVM_QA_V1\",\"checks\":"+checks+",\"normalRequests\":4096,\"reservedFirstReleases\":64,\"noReplyEviction\":true,\"realOidcOrFlowableTested\":false}");
    }
}

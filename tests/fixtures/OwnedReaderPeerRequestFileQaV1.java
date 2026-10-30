package com.idms.lifecycle;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

/** Actual file I/O only: no target JVM, agent invocation, SQL or reader authorization. */
public final class OwnedReaderPeerRequestFileQaV1 {
    private static int checks=0;
    private static void need(boolean value){if(!value)throw new AssertionError("READER_PEER_REQUEST_FILE_QA");}
    private static void rejects(Throwing operation) throws Exception {
        try{operation.run();}catch(Exception expected){checks++;return;}
        throw new AssertionError("READER_PEER_REQUEST_FILE_ACCEPTED_INVALID");
    }
    @FunctionalInterface interface Throwing{void run()throws Exception;}
    private static LifecycleWireV1.Binding binding(Path directory,String request,String jar){
        return new LifecycleWireV1.Binding(UUID.randomUUID().toString(),"a".repeat(64),"b".repeat(64),directory.toString(),"1792950000000",request,"c".repeat(64),jar);
    }
    private static String body(LifecycleWireV1.Binding binding,String suffix){return LifecycleWireV1.options(binding)+";ACQUIRE;"+UUID.randomUUID()+";"+suffix+";"+"d".repeat(64);}
    public static void main(String[] args)throws Exception{
        need(args.length==1);Path parent=Path.of(args[0]).toRealPath();
        Path directory=Files.createDirectory(parent.resolve("original"));String prior=System.getProperty("idms.lifecycle.directory");
        try{
            System.setProperty("idms.lifecycle.directory",directory.toString());
            var first=binding(directory,UUID.randomUUID().toString(),directory.resolve("long-"+"j".repeat(1000)+".jar").toString());
            String firstBody=body(first,"-"),firstToken=OwnedReaderPeerAgentV1.writeRequest(first,firstBody);
            need(firstBody.getBytes(StandardCharsets.UTF_8).length>1024);
            need((directory.resolve("agent.jar")+"="+firstToken).getBytes(StandardCharsets.UTF_8).length<=1024);
            need(OwnedReaderPeerAgentV1.readRequest(firstToken).equals(firstBody));checks++;
            var unicode=binding(directory,UUID.randomUUID().toString(),directory.resolve("工作流-🚦.jar").toString());
            String unicodeBody=body(unicode,"sandbox"),unicodeToken=OwnedReaderPeerAgentV1.writeRequest(unicode,unicodeBody);
            need(OwnedReaderPeerAgentV1.readRequest(unicodeToken).equals(unicodeBody));checks++;
            rejects(()->OwnedReaderPeerAgentV1.writeRequest(first,firstBody));
            String prefix=firstToken.substring(0,firstToken.lastIndexOf(';')+1);
            rejects(()->OwnedReaderPeerAgentV1.readRequest(prefix+"0".repeat(64)));
            rejects(()->OwnedReaderPeerAgentV1.readRequest("UNKNOWN;"+first.request()+";"+"0".repeat(64)));
            rejects(()->OwnedReaderPeerAgentV1.readRequest("IDMS_READER_PEER_REQUEST_FILE_V1;../escape;"+"0".repeat(64)));
            Path file=directory.resolve("reader-peer-request-"+first.request()+".private.txt");
            Files.writeString(file,firstBody.replace("ACQUIRE","RELEASE"),StandardCharsets.UTF_8);
            rejects(()->OwnedReaderPeerAgentV1.readRequest(firstToken));
            Files.writeString(file,firstBody,StandardCharsets.UTF_8);
            Files.delete(file);rejects(()->OwnedReaderPeerAgentV1.readRequest(firstToken));
            var huge=binding(directory,UUID.randomUUID().toString(),directory.resolve("workflow.jar").toString());
            rejects(()->OwnedReaderPeerAgentV1.writeRequest(huge,"x".repeat(16385)));
            need(!Files.exists(directory.resolve("reader-peer-request-"+huge.request()+".private.txt")));checks++;
            Path other=Files.createDirectory(parent.resolve("other"));System.setProperty("idms.lifecycle.directory",other.toString());
            rejects(()->OwnedReaderPeerAgentV1.readRequest(unicodeToken));
            System.setProperty("idms.lifecycle.directory",directory.toString());
            String mismatched=body(binding(directory,UUID.randomUUID().toString(),directory.resolve("workflow.jar").toString()),"-");
            var wrong=binding(directory,UUID.randomUUID().toString(),directory.resolve("workflow.jar").toString());
            String wrongToken=OwnedReaderPeerAgentV1.writeRequest(wrong,mismatched);
            rejects(()->OwnedReaderPeerAgentV1.readRequest(wrongToken));
            need(checks==12);
            System.out.println("{\"format\":\"OWNED_READER_PEER_REQUEST_FILE_JVM_QA_V1\",\"checks\":12,\"actualFileIo\":true,\"longPayloadRoundTrip\":true,\"boundedLoadToken\":true,\"utf8Preserved\":true,\"attachedToAnyJvm\":false,\"actualOriginalTargetInvoked\":false,\"rawArgumentsOrCredentialsPrinted\":false}");
        }finally{if(prior==null)System.clearProperty("idms.lifecycle.directory");else System.setProperty("idms.lifecycle.directory",prior);}
    }
}

package com.idms.lifecycle;

import com.sun.tools.attach.VirtualMachine;
import java.nio.file.Path;
import java.util.Set;

/** Original expected identity and operation are unchanged; failure output has a fixed vocabulary. */
public final class OwnedReaderPeerAttachV1 {
    private static final Set<String> CODES=Set.of(
        "LIFECYCLE_INPUT","LIFECYCLE_AGENT","LIFECYCLE_FILE","LIFECYCLE_PATH",
        "LIFECYCLE_OWNER","LIFECYCLE_DEPLOYMENT","LIFECYCLE_JAR","LIFECYCLE_DIRECTORY",
        "LIFECYCLE_COMMAND","LIFECYCLE_OPT_IN","LIFECYCLE_REMOTE_JMX","LIFECYCLE_PROCESS_START",
        "LIFECYCLE_JMX_CONNECTOR_PRESENT","LIFECYCLE_NOT_READY","LIFECYCLE_CONFIGURATION",
        "LIFECYCLE_STOP_ALREADY_STARTED","LIFECYCLE_RECEIPT"
    );
    static String safeCode(Exception e){String message=e.getMessage();return message!=null&&CODES.contains(message)?message:"OWNED_READER_PEER_REPLY_UNCONFIRMED";}
    static String safeType(Exception e){
        return switch(e.getClass().getName()){
            case "java.lang.IllegalStateException","java.lang.IllegalArgumentException","java.lang.SecurityException",
                 "java.io.IOException","java.io.FileNotFoundException","java.nio.file.NoSuchFileException",
                 "java.nio.file.AccessDeniedException","com.sun.tools.attach.AttachNotSupportedException",
                 "com.sun.tools.attach.AttachOperationFailedException","com.sun.tools.attach.AgentLoadException",
                 "com.sun.tools.attach.AgentInitializationException" -> e.getClass().getName();
            default -> "java.lang.Exception";
        };
    }
    public static void main(String[] args){
        VirtualMachine vm=null;String stage="INPUT";
        try{
            LifecycleWireV1.need(args.length==7&&args[0].matches("[1-9][0-9]{0,9}"),"LIFECYCLE_INPUT");
            long pid=Long.parseLong(args[0]);var binding=LifecycleWireV1.parse(args[1]);
            LifecycleWireV1.need(!binding.start().equals("-")&&LifecycleWireV1.uuid(binding.request())&&LifecycleWireV1.uuid(args[4])&&java.util.Set.of("ACQUIRE","PROBE","CAPTURE","RELEASE").contains(args[3])&&(args[5].equals("-")||args[5].matches("[A-Za-z0-9_-]{1,80}"))&&LifecycleWireV1.hash(args[6]),"LIFECYCLE_INPUT");
            stage="AGENT_HASH";LifecycleWireV1.need(LifecycleWireV1.sha(Path.of(args[2])).equals(binding.agentHash()),"LIFECYCLE_AGENT");
            stage="ATTACH";vm=VirtualMachine.attach(args[0]);stage="IDENTITY_BEFORE";LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            stage="AGENT_PROPERTIES";LifecycleWireV1.need(vm.getAgentProperties().getProperty("com.sun.management.jmxremote.localConnectorAddress")==null,"LIFECYCLE_JMX_CONNECTOR_PRESENT");
            stage="AGENT_LOAD";vm.loadAgent(args[2],String.join(";",args[1],args[3],args[4],args[5],args[6]));
            stage="IDENTITY_AFTER";LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            System.out.println("OWNED_READER_PEER_AGENT_RETURNED");
        }catch(Exception e){
            System.err.println("OWNED_READER_PEER_REPLY_UNCONFIRMED");
            System.err.println("OWNED_READER_PEER_ATTACH_DIAGNOSTIC_V1 stage="+stage+" type="+safeType(e)+" code="+safeCode(e));
            System.exit(2);
        }
        finally{if(vm!=null)try{vm.detach();}catch(Exception ignored){}}
    }
}

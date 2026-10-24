package com.idms.lifecycle;

import com.sun.tools.attach.VirtualMachine;
import java.nio.file.Path;

/** Original expected JVM identity is checked before this fixed local agent loads. */
public final class OwnedReaderPeerAttachV1 {
    public static void main(String[] args){
        VirtualMachine vm=null;
        try{
            LifecycleWireV1.need(args.length==7&&args[0].matches("[1-9][0-9]{0,9}"),"LIFECYCLE_INPUT");
            long pid=Long.parseLong(args[0]);var binding=LifecycleWireV1.parse(args[1]);
            LifecycleWireV1.need(!binding.start().equals("-")&&LifecycleWireV1.uuid(binding.request())&&LifecycleWireV1.uuid(args[4])&&java.util.Set.of("ACQUIRE","PROBE","CAPTURE","RELEASE").contains(args[3])&&(args[5].equals("-")||args[5].matches("[A-Za-z0-9_-]{1,80}"))&&LifecycleWireV1.hash(args[6]),"LIFECYCLE_INPUT");
            LifecycleWireV1.need(LifecycleWireV1.sha(Path.of(args[2])).equals(binding.agentHash()),"LIFECYCLE_AGENT");
            vm=VirtualMachine.attach(args[0]);LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            LifecycleWireV1.need(vm.getAgentProperties().getProperty("com.sun.management.jmxremote.localConnectorAddress")==null,"LIFECYCLE_JMX_CONNECTOR_PRESENT");
            vm.loadAgent(args[2],String.join(";",args[1],args[3],args[4],args[5],args[6]));
            LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            System.out.println("OWNED_READER_PEER_AGENT_RETURNED");
        }catch(Exception e){System.err.println("OWNED_READER_PEER_REPLY_UNCONFIRMED");System.exit(2);}
        finally{if(vm!=null)try{vm.detach();}catch(Exception ignored){}}
    }
}

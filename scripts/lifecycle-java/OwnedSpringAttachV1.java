package com.idms.lifecycle;

import com.sun.tools.attach.VirtualMachine;
import java.nio.file.Path;

/** Checks the independently supplied expected identity before any agent load. */
public final class OwnedSpringAttachV1 {
    public static void main(String[] args) {
        VirtualMachine vm=null;
        try{
            LifecycleWireV1.need(args.length==4&&(args[0].equals("PROBE")||args[0].equals("STOP"))&&args[1].matches("[1-9][0-9]{0,9}"),"LIFECYCLE_INPUT");
            long pid=Long.parseLong(args[1]);var binding=LifecycleWireV1.parse(args[2]);
            vm=VirtualMachine.attach(args[1]);LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            LifecycleWireV1.need(vm.getAgentProperties().getProperty("com.sun.management.jmxremote.localConnectorAddress")==null,"LIFECYCLE_JMX_CONNECTOR_PRESENT");
            if(args[0].equals("PROBE")){System.out.println(LifecycleWireV1.json(LifecycleWireV1.receipt(binding,"BOUND",pid)));return;}
            LifecycleWireV1.need(LifecycleWireV1.uuid(binding.request())&&LifecycleWireV1.sha(Path.of(args[3])).equals(binding.agentHash()),"LIFECYCLE_AGENT");
            vm.loadAgent(args[3],args[2]);System.out.println("LIFECYCLE_AGENT_RETURNED");
        }catch(Exception e){String code=e.getMessage();System.err.println(code!=null&&code.matches("LIFECYCLE_[A-Z_]+")?code:"LIFECYCLE_ATTACH_OR_AGENT_UNCONFIRMED");System.exit(2);}
        finally{if(vm!=null)try{vm.detach();}catch(Exception ignored){}}
    }
}

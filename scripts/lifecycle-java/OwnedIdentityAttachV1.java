package com.idms.identitylife;
import com.sun.tools.attach.VirtualMachine;
import java.nio.file.Path;
public final class OwnedIdentityAttachV1 {
    public static void main(String[] args){VirtualMachine vm=null;try{
        IdentityLifecycleWireV1.need(args.length==4&&(args[0].equals("PROBE")||args[0].equals("STOP"))&&args[1].matches("[1-9][0-9]{0,9}"),"IDENTITY_INPUT");
        long pid=Long.parseLong(args[1]);var b=IdentityLifecycleWireV1.parse(args[2]);vm=VirtualMachine.attach(args[1]);IdentityLifecycleWireV1.check(vm.getSystemProperties(),b,pid);
        IdentityLifecycleWireV1.need(vm.getAgentProperties().getProperty("com.sun.management.jmxremote.localConnectorAddress")==null,"IDENTITY_JMX_CONNECTOR");
        if(args[0].equals("PROBE")){System.out.println(IdentityLifecycleWireV1.json(IdentityLifecycleWireV1.receipt(b,"BOUND",pid)));return;}
        IdentityLifecycleWireV1.need(IdentityLifecycleWireV1.uuid(b.request())&&IdentityLifecycleWireV1.sha(Path.of(args[3])).equals(b.agentHash()),"IDENTITY_AGENT");vm.loadAgent(args[3],args[2]);System.out.println("IDENTITY_AGENT_RETURNED");
    }catch(Exception e){String c=e.getMessage();System.err.println(c!=null&&c.matches("IDENTITY_[A-Z_]+")?c:"IDENTITY_ATTACH_OR_AGENT_UNCONFIRMED");System.exit(2);}finally{if(vm!=null)try{vm.detach();}catch(Exception ignored){}}}
}

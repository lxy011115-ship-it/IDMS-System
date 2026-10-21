package com.idms.identitylife;
import com.sun.tools.attach.VirtualMachine;
/** QA-only: bypass outer checks to test the agent's own guard. */
public final class IdentityAgentGuardQaV1 {
    public static void main(String[] args)throws Exception{VirtualMachine vm=VirtualMachine.attach(args[0]);try{vm.loadAgent(args[1],args[2]);}finally{vm.detach();}}
}

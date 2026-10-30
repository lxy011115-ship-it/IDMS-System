package com.idms.lifecycle.qa;

import com.sun.tools.attach.VirtualMachine;

/** Negative agent-boundary test, after checking the known QA VM identity. */
public final class LifecycleAgentGuardQaV1 {
    public static void main(String[] a) throws Exception {
        if(a.length!=6||!a[0].equals("GUARD_NEGATIVE_TEST_ONLY"))throw new IllegalArgumentException();
        long pid=Long.parseLong(a[1]);if(ProcessHandle.of(pid).orElseThrow().info().startInstant().orElseThrow().toEpochMilli()!=Long.parseLong(a[3]))throw new IllegalStateException("QA_START");
        VirtualMachine vm=VirtualMachine.attach(a[1]);try{
            if(!a[2].equals(vm.getSystemProperties().getProperty("idms.lifecycle.owner"))||a[5].startsWith(a[2]+"|"))throw new IllegalStateException("QA_OWNER");
            try{vm.loadAgent(a[4],a[5]);throw new IllegalStateException("QA_AGENT_ACCEPTED_BAD_OWNER");}catch(com.sun.tools.attach.AgentInitializationException expected){System.out.println("QA_AGENT_OWNER_REJECTED");}
        }finally{vm.detach();}
    }
}

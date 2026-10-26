package com.idms.lifecycle;

import com.sun.tools.attach.VirtualMachine;
import java.util.Map;

/** One short-lived helper, three fresh attach observations. No persistent agent,
 * connector, cached identity, SQL, caller callback, or process stop is added. */
public final class OwnedReaderPeerBracketV1 {
    private static Map<String,String> probe(String pidText, LifecycleWireV1.Binding binding) throws Exception {
        VirtualMachine vm=null;
        try {
            long pid=Long.parseLong(pidText);
            vm=VirtualMachine.attach(pidText);
            LifecycleWireV1.check(vm.getSystemProperties(),binding,pid);
            LifecycleWireV1.need(vm.getAgentProperties().getProperty("com.sun.management.jmxremote.localConnectorAddress")==null,"LIFECYCLE_JMX_CONNECTOR_PRESENT");
            return LifecycleWireV1.receipt(binding,"BOUND",pid);
        } finally { if(vm!=null)vm.detach(); }
    }
    public static void main(String[] args) {
        try {
            LifecycleWireV1.need(args.length==9&&args[0].matches("[1-9][0-9]{0,9}"),"LIFECYCLE_INPUT");
            var lifecycle=LifecycleWireV1.parse(args[1]);
            var peer=LifecycleWireV1.parse(args[3]);
            LifecycleWireV1.need(!lifecycle.start().equals("-")&&lifecycle.request().equals("-")&&LifecycleWireV1.uuid(peer.request()),"LIFECYCLE_INPUT");
            LifecycleWireV1.need(lifecycle.owner().equals(peer.owner())&&lifecycle.deployment().equals(peer.deployment())&&lifecycle.jarHash().equals(peer.jarHash())&&lifecycle.directory().equals(peer.directory())&&lifecycle.start().equals(peer.start())&&lifecycle.jar().equals(peer.jar()),"LIFECYCLE_INPUT");
            var before=probe(args[0],lifecycle);
            // Execute the frozen original peer helper. It independently attaches,
            // checks identity before/after, writes a one-use request file, loads
            // the original agent and exits nonzero on an unconfirmed operation.
            OwnedReaderPeerAttachV1.main(new String[]{args[0],args[3],args[4],args[5],args[6],args[7],args[8]});
            var after=probe(args[0],lifecycle);
            System.out.println("{\"format\":\"IDMS_READER_PEER_LIFECYCLE_BRACKET_V1\",\"requestId\":"+LifecycleWireV1.quote(peer.request())+",\"before\":"+LifecycleWireV1.json(before)+",\"after\":"+LifecycleWireV1.json(after)+"}");
        } catch(Exception e) {
            System.err.println("READER_PEER_LIFECYCLE_BRACKET_UNCONFIRMED");
            System.err.println("READER_PEER_LIFECYCLE_BRACKET_DIAGNOSTIC_V1 type="+OwnedReaderPeerAttachV1.safeType(e)+" code="+OwnedReaderPeerAttachV1.safeCode(e));
            System.exit(2);
        }
    }
}

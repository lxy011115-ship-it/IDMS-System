package com.idms.lifecycle;

import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Set;
import javax.management.ObjectName;

/** Fixed object/operation only. No JMX connector, arbitrary reflection, SQL or PID stop. */
public final class OwnedReaderPeerAgentV1 {
    public static synchronized void agentmain(String options,Instrumentation ignored) throws Exception {
        String[] v=options.split(";",-1);LifecycleWireV1.need(v.length==5,"LIFECYCLE_INPUT");
        var b=LifecycleWireV1.parse(v[0]);long pid=ProcessHandle.current().pid();LifecycleWireV1.check(System.getProperties(),b,pid);
        LifecycleWireV1.need(!b.start().equals("-")&&LifecycleWireV1.uuid(b.request())&&LifecycleWireV1.uuid(v[2])&&Set.of("ACQUIRE","PROBE","CAPTURE","RELEASE").contains(v[1])&&(v[3].equals("-")||v[3].matches("[A-Za-z0-9_-]{1,80}"))&&LifecycleWireV1.hash(v[4]),"LIFECYCLE_INPUT");
        Path ownJar=Path.of(OwnedReaderPeerAgentV1.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        LifecycleWireV1.need(LifecycleWireV1.sha(ownJar).equals(b.agentHash()),"LIFECYCLE_AGENT");
        LifecycleWireV1.need(System.getProperty("idms.lifecycle.stop-request")==null,"LIFECYCLE_STOP_ALREADY_STARTED");
        var server=ManagementFactory.getPlatformMBeanServer();var name=new ObjectName("com.idms.workflowreview:type=OwnedReaderPeers");
        var admin=new ObjectName("org.springframework.boot:type=Admin,name=SpringApplication");
        LifecycleWireV1.need(server.isRegistered(name)&&server.isRegistered(admin)&&Boolean.TRUE.equals(server.getAttribute(admin,"Ready")),"LIFECYCLE_NOT_READY");
        String request="{\"format\":\"IDMS_OWNED_READER_PEER_REQUEST_V1\",\"operation\":"+LifecycleWireV1.quote(v[1])+",\"leaseId\":"+LifecycleWireV1.quote(v[2])+",\"requestId\":"+LifecycleWireV1.quote(b.request())+",\"tenantId\":"+LifecycleWireV1.quote(v[3])+"}";
        // Config is compared inside the actual service before and after its operation.
        String configured=System.getenv("IDMS_WORKFLOW_READER_CONFIG");
        LifecycleWireV1.need(configured!=null&&LifecycleWireV1.sha(Path.of(configured)).equals(v[4]),"LIFECYCLE_CONFIGURATION");
        Object raw=server.invoke(name,"exchange",new Object[]{request},new String[]{"java.lang.String"});
        LifecycleWireV1.need(raw instanceof String,"LIFECYCLE_RECEIPT");
        LifecycleWireV1.check(System.getProperties(),b,pid);LifecycleWireV1.need(LifecycleWireV1.sha(Path.of(configured)).equals(v[4]),"LIFECYCLE_CONFIGURATION");
        byte[] bytes=("{\"binding\":"+LifecycleWireV1.json(LifecycleWireV1.receipt(b,"READER_PEER",pid))+",\"payload\":"+raw+"}\n").getBytes(StandardCharsets.UTF_8);
        LifecycleWireV1.need(bytes.length<=4*1024*1024+65536,"LIFECYCLE_RECEIPT");
        Path out=Path.of(b.directory(),"reader-peer-"+b.request()+".private.json");
        try(FileChannel channel=FileChannel.open(out,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)){
            ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())channel.write(buffer);channel.force(true);
        }
    }
}

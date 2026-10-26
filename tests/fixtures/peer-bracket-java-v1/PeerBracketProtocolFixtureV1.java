package com.idms.lifecycle;

import java.lang.management.ManagementFactory;
import javax.management.ObjectName;
import javax.management.StandardMBean;

/** An explicit protocol fixture. Echoes requests only; contains no database,
 * workflow engine, lease, permission decision or production reader response. */
public final class PeerBracketProtocolFixtureV1 {
    public interface AdminMBean { boolean getReady(); }
    public static final class Admin implements AdminMBean { public boolean getReady(){return true;} }
    public interface EchoMBean { String exchange(String request); }
    public static final class Echo implements EchoMBean { public String exchange(String request){return request;} }
    public static void main(String[] args) throws Exception {
        var server=ManagementFactory.getPlatformMBeanServer();
        var admin=new ObjectName("org.springframework.boot:type=Admin,name=SpringApplication");
        var echo=new ObjectName("com.idms.workflowreview:type=OwnedReaderPeers");
        server.registerMBean(new StandardMBean(new Admin(),AdminMBean.class),admin);
        server.registerMBean(new StandardMBean(new Echo(),EchoMBean.class),echo);
        System.out.println("PROTOCOL_FIXTURE_READY "+ProcessHandle.current().pid()+" "+LifecycleWireV1.start(ProcessHandle.current().pid()));
        System.out.flush();
        while(System.in.read()!=-1){}
        server.unregisterMBean(echo);server.unregisterMBean(admin);
    }
}

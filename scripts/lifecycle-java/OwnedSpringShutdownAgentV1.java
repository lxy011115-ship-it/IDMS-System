package com.idms.lifecycle;

import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.management.ObjectName;

/** Local, explicit opt-in only. No process signal, System.exit or JMX connector. */
public final class OwnedSpringShutdownAgentV1 {
    public static synchronized void agentmain(String options,Instrumentation ignored) throws Exception {
        var b=LifecycleWireV1.parse(options);long pid=ProcessHandle.current().pid();LifecycleWireV1.check(System.getProperties(),b,pid);
        Path ownJar=Path.of(OwnedSpringShutdownAgentV1.class.getProtectionDomain().getCodeSource().getLocation().toURI());LifecycleWireV1.need(LifecycleWireV1.sha(ownJar).equals(b.agentHash()),"LIFECYCLE_AGENT");
        LifecycleWireV1.need(System.getProperty("idms.lifecycle.stop-request")==null,"LIFECYCLE_STOP_ALREADY_STARTED");
        var server=ManagementFactory.getPlatformMBeanServer();var name=new ObjectName("org.springframework.boot:type=Admin,name=SpringApplication");
        LifecycleWireV1.need(server.isRegistered(name)&&Boolean.TRUE.equals(server.getAttribute(name,"Ready")),"LIFECYCLE_NOT_READY");
        LifecycleWireV1.need("graceful".equals(server.invoke(name,"getProperty",new Object[]{"server.shutdown"},new String[]{"java.lang.String"})),"LIFECYCLE_GRACEFUL_NOT_CONFIGURED");
        LifecycleWireV1.writeReceipt(b,"STOP_STARTED","started");System.setProperty("idms.lifecycle.stop-request",b.request());
        AtomicReference<Exception> failure=new AtomicReference<>();Thread worker=new Thread(()->{try{server.invoke(name,"shutdown",new Object[0],new String[0]);LifecycleWireV1.writeReceipt(b,"STOP_COMPLETED","completed");}catch(Exception e){failure.set(e);try{LifecycleWireV1.writeReceipt(b,"STOP_FAILED","failed");}catch(Exception ignoredWrite){}}},"idms-context-close-"+b.request());
        worker.setContextClassLoader(server.getClassLoaderFor(name));worker.setDaemon(false);worker.start();worker.join();if(failure.get()!=null)throw new IllegalStateException("LIFECYCLE_CONTEXT_CLOSE_FAILED");
    }
}

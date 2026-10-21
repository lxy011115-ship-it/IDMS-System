package com.idms.identitylife;
import java.lang.instrument.Instrumentation;
import java.nio.file.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
public final class OwnedIdentityShutdownAgentV1 {
    public static synchronized void agentmain(String raw,Instrumentation instrumentation)throws Exception{
        var b=IdentityLifecycleWireV1.parse(raw);IdentityLifecycleWireV1.check(System.getProperties(),b,ProcessHandle.current().pid());
        Path own=Path.of(OwnedIdentityShutdownAgentV1.class.getProtectionDomain().getCodeSource().getLocation().toURI());IdentityLifecycleWireV1.need(IdentityLifecycleWireV1.sha(own).equals(b.agentHash()),"IDENTITY_AGENT");
        IdentityLifecycleWireV1.need(System.getProperty("idms.identitylife.stop-request")==null,"IDENTITY_ALREADY_STOPPING");
        Class<?> quarkus=null,application=null;int q=0,a=0;for(Class<?> c:instrumentation.getAllLoadedClasses()){if(c.getName().equals("io.quarkus.runtime.Quarkus")){quarkus=c;q++;}if(c.getName().equals("io.quarkus.runtime.Application")){application=c;a++;}}
        IdentityLifecycleWireV1.need(q==1&&a==1&&quarkus.getClassLoader()==application.getClassLoader(),"IDENTITY_QUARKUS_CLASSLOADER");
        String core=IdentityLifecycleWireV1.path(Path.of(quarkus.getProtectionDomain().getCodeSource().getLocation().toURI()).toString());IdentityLifecycleWireV1.need(core.equals(IdentityLifecycleWireV1.path(Path.of(b.root(),"lib/lib/main/io.quarkus.quarkus-core-3.40.1.jar").toString())),"IDENTITY_QUARKUS_SOURCE");
        Object app=application.getMethod("currentApplication").invoke(null);IdentityLifecycleWireV1.need(app!=null&&Boolean.TRUE.equals(application.getMethod("isStarted").invoke(app)),"IDENTITY_NOT_READY");
        var exit=quarkus.getMethod("blockingExit");CountDownLatch written=new CountDownLatch(1);
        String released=IdentityLifecycleWireV1.json(IdentityLifecycleWireV1.receipt(b,"CONTROLLER_RELEASED",ProcessHandle.current().pid()))+"\n";Path releaseFile=Path.of(b.directory(),"shutdown-"+b.request()+".controller-release.json");
        // Hold the framework's final VM halt until the caller has observed the
        // Attach helper terminal. Otherwise System.exit can cut its native reply.
        Thread gate=new Thread(()->{boolean interrupted=false;for(;;)try{written.await();break;}catch(InterruptedException e){interrupted=true;}
            for(;;){try{if(Files.isRegularFile(releaseFile,LinkOption.NOFOLLOW_LINKS)&&!Files.isSymbolicLink(releaseFile)&&Files.size(releaseFile)<65536&&Files.readString(releaseFile).equals(released))break;}catch(Exception ignored){}try{Thread.sleep(25);}catch(InterruptedException e){interrupted=true;}}
            if(interrupted)Thread.currentThread().interrupt();},"idms-identity-receipt-gate-"+b.request());
        Runtime.getRuntime().addShutdownHook(gate);
        try{IdentityLifecycleWireV1.write(b,"STOP_STARTED","started");}catch(Exception e){written.countDown();Runtime.getRuntime().removeShutdownHook(gate);throw e;}
        System.setProperty("idms.identitylife.stop-request",b.request());AtomicReference<Exception> failure=new AtomicReference<>();
        Thread worker=new Thread(()->{try{exit.invoke(null);IdentityLifecycleWireV1.need(!Boolean.TRUE.equals(applicationStarted(app)),"IDENTITY_STILL_STARTED");IdentityLifecycleWireV1.write(b,"STOP_COMPLETED","completed");}catch(Exception e){failure.set(e);try{IdentityLifecycleWireV1.write(b,"STOP_FAILED","failed");}catch(Exception ignored){}}finally{written.countDown();}},"idms-identity-close-"+b.request());
        worker.setContextClassLoader(quarkus.getClassLoader());worker.setDaemon(false);worker.start();worker.join();if(failure.get()!=null)throw new IllegalStateException("IDENTITY_CLOSE_UNCONFIRMED");
    }
    private static Object applicationStarted(Object app)throws Exception{return app.getClass().getMethod("isStarted").invoke(app);}
}

import java.nio.file.*;
import java.util.*;

/** Isolated-test entry only: an exact per-run file requests normal JVM shutdown hooks. */
public final class OwnedStartupJvm {
 public static void main(String[] args) throws Exception {
  String request=System.getProperty("idms.qa.stopFile"),nonce=System.getProperty("idms.qa.nonce");
  if(request==null||nonce==null||!nonce.matches("[a-f0-9]{32}"))throw new IllegalStateException("QA_OWNERSHIP_REQUIRED");
  Thread stop=new Thread(()->{for(;;){try{
   Path p=Path.of(request);
   if(Files.exists(p)&&Files.readString(p).equals(nonce+":"+ProcessHandle.current().pid())){System.exit(0);return;}
   Thread.sleep(100);
  }catch(Exception e){return;}}},"owned-qa-normal-stop");stop.setDaemon(true);stop.start();
  Class<?> target=Class.forName(args[0]);
  target.getMethod("main",String[].class).invoke(null,(Object)Arrays.copyOfRange(args,1,args.length));
 }
}

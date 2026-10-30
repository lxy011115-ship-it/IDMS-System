package com.idms.lifecycle;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

final class LifecycleWireV1 {
    record Binding(String owner,String deployment,String jarHash,String directory,String start,String request,String agentHash,String jar) {}
    static void need(boolean ok,String code){if(!ok)throw new IllegalStateException(code);}
    static boolean uuid(String s){return s!=null&&s.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}");}
    static boolean hash(String s){return s!=null&&s.matches("[a-f0-9]{64}");}
    static String canonicalPath(String p) throws Exception {Path path=Path.of(p).toAbsolutePath().normalize();need(Files.exists(path,LinkOption.NOFOLLOW_LINKS)&&!Files.isSymbolicLink(path),"LIFECYCLE_PATH");return path.toRealPath().toString();}
    static String sha(Path p) throws Exception {need(Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS)&&!Files.isSymbolicLink(p),"LIFECYCLE_FILE");MessageDigest d=MessageDigest.getInstance("SHA-256");try(var in=Files.newInputStream(p)){byte[] b=new byte[65536];for(int n;(n=in.read(b))!=-1;)d.update(b,0,n);}return HexFormat.of().formatHex(d.digest());}
    static String b64(String s){return Base64.getUrlEncoder().withoutPadding().encodeToString(s.getBytes(StandardCharsets.UTF_8));}
    static String unb64(String s){return new String(Base64.getUrlDecoder().decode(s),StandardCharsets.UTF_8);}
    static String options(Binding b){return String.join("|",b.owner,b.deployment,b.jarHash,b64(b.directory),b.start,b.request,b.agentHash,b64(b.jar));}
    static Binding parse(String raw){String[] p=raw.split("\\|",-1);need(p.length==8,"LIFECYCLE_INPUT");return new Binding(p[0],p[1],p[2],unb64(p[3]),p[4],p[5],p[6],unb64(p[7]));}
    static long start(long pid){return ProcessHandle.of(pid).orElseThrow().info().startInstant().orElseThrow().toEpochMilli();}
    static void check(Properties properties,Binding b,long pid) throws Exception {
        need(uuid(b.owner)&&hash(b.deployment)&&hash(b.jarHash)&&hash(b.agentHash)&&(b.start.equals("-")||b.start.matches("[0-9]{10,16}"))&&(b.request.equals("-")||uuid(b.request)),"LIFECYCLE_INPUT");
        need(b.owner.equals(properties.getProperty("idms.lifecycle.owner")),"LIFECYCLE_OWNER");
        need(b.deployment.equals(properties.getProperty("idms.lifecycle.deployment")),"LIFECYCLE_DEPLOYMENT");
        need(b.jarHash.equals(properties.getProperty("idms.lifecycle.jar-sha256")),"LIFECYCLE_JAR");
        need(canonicalPath(b.directory).equals(properties.getProperty("idms.lifecycle.directory")),"LIFECYCLE_DIRECTORY");
        need(canonicalPath(b.jar).equals(properties.getProperty("idms.lifecycle.jar"))&&sha(Path.of(b.jar)).equals(b.jarHash),"LIFECYCLE_JAR");
        String command=properties.getProperty("sun.java.command","");need(command.equals(b.jar)||command.startsWith(b.jar+" "),"LIFECYCLE_COMMAND");
        need("true".equals(properties.getProperty("spring.application.admin.enabled")),"LIFECYCLE_OPT_IN");
        need(properties.getProperty("com.sun.management.jmxremote.port")==null,"LIFECYCLE_REMOTE_JMX");
        need(b.start.equals("-")||Long.toString(start(pid)).equals(b.start),"LIFECYCLE_PROCESS_START");
    }
    static String quote(String s){StringBuilder out=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();}
    static String json(Map<String,String> m){List<String> items=new ArrayList<>();new TreeMap<>(m).forEach((k,v)->items.add(quote(k)+":"+quote(v)));return "{"+String.join(",",items)+"}";}
    static Map<String,String> receipt(Binding b,String phase,long pid){Map<String,String> m=new TreeMap<>();m.put("format","IDMS_WORKFLOW_LIFECYCLE_V1");m.put("phase",phase);m.put("pid",Long.toString(pid));m.put("start",Long.toString(start(pid)));m.put("owner",b.owner);m.put("deployment",b.deployment);m.put("jarSha256",b.jarHash);m.put("agentSha256",b.agentHash);m.put("requestId",b.request);m.put("directory",b.directory);return m;}
    static Path receiptPath(Binding b,String suffix){need(uuid(b.request),"LIFECYCLE_REQUEST");return Path.of(b.directory,"shutdown-"+b.request+"."+suffix+".json");}
    static void writeReceipt(Binding b,String phase,String suffix) throws Exception {Path path=receiptPath(b,suffix);byte[] bytes=(json(receipt(b,phase,ProcessHandle.current().pid()))+"\n").getBytes(StandardCharsets.UTF_8);try(FileChannel channel=FileChannel.open(path,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)){ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())channel.write(buffer);channel.force(true);}}
}

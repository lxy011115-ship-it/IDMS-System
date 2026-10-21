package com.idms.identitylife;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

final class IdentityLifecycleWireV1 {
    record Binding(String owner,String deployment,String manifestHash,String directory,String start,String request,String agentHash,String root,String manifest) {}
    static void need(boolean ok,String code){if(!ok)throw new IllegalStateException(code);}
    static boolean uuid(String s){return s!=null&&s.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}");}
    static boolean hash(String s){return s!=null&&s.matches("[a-f0-9]{64}");}
    static String path(String value)throws Exception{Path p=Path.of(value).toAbsolutePath().normalize();for(Path c=p;c!=null;c=c.getParent())need(!Files.isSymbolicLink(c),"IDENTITY_PATH_LINK");return p.toRealPath().toString();}
    static String sha(Path p)throws Exception{need(Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS),"IDENTITY_FILE");MessageDigest d=MessageDigest.getInstance("SHA-256");try(var in=Files.newInputStream(p)){byte[] b=new byte[65536];for(int n;(n=in.read(b))!=-1;)d.update(b,0,n);}return HexFormat.of().formatHex(d.digest());}
    static String unb64(String v){return new String(Base64.getUrlDecoder().decode(v),StandardCharsets.UTF_8);}
    static Binding parse(String raw){String[] p=raw.split("\\|",-1);need(p.length==9,"IDENTITY_INPUT");return new Binding(p[0],p[1],p[2],unb64(p[3]),p[4],p[5],p[6],unb64(p[7]),unb64(p[8]));}
    static long start(long pid){return ProcessHandle.of(pid).orElseThrow().info().startInstant().orElseThrow().toEpochMilli();}
    static Map<String,String> manifest(Binding b)throws Exception{
        need(path(b.manifest).equals(Path.of(b.directory,"runtime-manifest.txt").toString())&&sha(Path.of(b.manifest)).equals(b.manifestHash),"IDENTITY_MANIFEST");
        Path root=Path.of(path(b.root));Map<String,String> pins=new TreeMap<>();
        for(String line:Files.readAllLines(Path.of(b.manifest),StandardCharsets.UTF_8)){String[] p=line.split("\\t",-1);need(p.length==2&&hash(p[0])&&p[1].matches("[A-Za-z0-9._/-]+")&&!p[1].contains(".."),"IDENTITY_MANIFEST_ENTRY");Path file=root.resolve(p[1]).normalize();need(file.startsWith(root)&&path(file.toString()).equals(file.toString()),"IDENTITY_MANIFEST_PATH");need(pins.put(p[1],p[0])==null&&sha(file).equals(p[0]),"IDENTITY_RUNTIME_DRIFT");}
        need(pins.size()>100&&pins.containsKey("lib/quarkus-run.jar")&&pins.containsKey("conf/keycloak.conf")&&pins.containsKey("lib/lib/main/io.quarkus.quarkus-core-3.40.1.jar"),"IDENTITY_MANIFEST_SCOPE");return pins;
    }
    static void check(Properties p,Binding b,long pid)throws Exception{
        need(uuid(b.owner)&&hash(b.deployment)&&hash(b.manifestHash)&&hash(b.agentHash)&&(b.start.equals("-")||b.start.matches("[0-9]{10,16}"))&&(b.request.equals("-")||uuid(b.request)),"IDENTITY_INPUT");
        need(b.owner.equals(p.getProperty("idms.identitylife.owner")),"IDENTITY_OWNER");need(b.deployment.equals(p.getProperty("idms.identitylife.deployment")),"IDENTITY_DEPLOYMENT");need(b.manifestHash.equals(p.getProperty("idms.identitylife.manifest-sha256")),"IDENTITY_MANIFEST");
        need(path(b.directory).equals(p.getProperty("idms.identitylife.directory"))&&path(b.root).equals(p.getProperty("kc.home.dir"))&&path(Path.of(b.root,"conf").toString()).equals(p.getProperty("jboss.server.config.dir")),"IDENTITY_DIRECTORY");
        need("true".equals(p.getProperty("idms.identitylife.enabled")),"IDENTITY_OPT_IN");need(p.getProperty("com.sun.management.jmxremote.port")==null,"IDENTITY_REMOTE_JMX");
        need(("io.quarkus.bootstrap.runner.QuarkusEntryPoint --config-file="+Path.of(b.root,"conf/keycloak.conf")+" start-dev").equals(p.getProperty("sun.java.command")),"IDENTITY_COMMAND");
        need(path(Path.of(b.root,"lib/quarkus-run.jar").toString()).equals(path(p.getProperty("java.class.path"))),"IDENTITY_CLASSPATH");need(b.start.equals("-")||b.start.equals(Long.toString(start(pid))),"IDENTITY_PROCESS_START");manifest(b);
    }
    static String quote(String s){StringBuilder o=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')o.append('\\').append(c);else if(c<32)o.append(String.format("\\u%04x",(int)c));else o.append(c);}return o.append('"').toString();}
    static String json(Map<String,String> m){List<String> o=new ArrayList<>();new TreeMap<>(m).forEach((k,v)->o.add(quote(k)+":"+quote(v)));return "{"+String.join(",",o)+"}";}
    static Map<String,String> receipt(Binding b,String phase,long pid){Map<String,String> m=new TreeMap<>();m.put("format","IDMS_IDENTITY_LIFECYCLE_V1");m.put("phase",phase);m.put("pid",Long.toString(pid));m.put("start",Long.toString(start(pid)));m.put("owner",b.owner);m.put("deployment",b.deployment);m.put("manifestSha256",b.manifestHash);m.put("agentSha256",b.agentHash);m.put("requestId",b.request);m.put("directory",b.directory);return m;}
    static void write(Binding b,String phase,String suffix)throws Exception{need(uuid(b.request),"IDENTITY_REQUEST");Path p=Path.of(b.directory,"shutdown-"+b.request+"."+suffix+".json");byte[] bytes=(json(receipt(b,phase,ProcessHandle.current().pid()))+"\n").getBytes(StandardCharsets.UTF_8);try(FileChannel c=FileChannel.open(p,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)){ByteBuffer v=ByteBuffer.wrap(bytes);while(v.hasRemaining())c.write(v);c.force(true);}}
}

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
    private static final String REQUEST_FORMAT="IDMS_READER_PEER_REQUEST_FILE_V1";
    private static final int REQUEST_MAX_BYTES=16384;
    private static Path requestPath(String directory,String request) throws Exception {
        LifecycleWireV1.need(LifecycleWireV1.uuid(request),"LIFECYCLE_INPUT");
        Path parent=Path.of(directory).toAbsolutePath().normalize();
        LifecycleWireV1.need(parent.toString().equals(directory)&&LifecycleWireV1.canonicalPath(directory).equals(directory),"LIFECYCLE_PATH");
        return parent.resolve("reader-peer-request-"+request+".private.txt");
    }
    static String writeRequest(LifecycleWireV1.Binding binding,String body) throws Exception {
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
        LifecycleWireV1.need(bytes.length>0&&bytes.length<=REQUEST_MAX_BYTES&&!body.contains("\u0000"),"LIFECYCLE_INPUT");
        String expectedDigest=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        Path file=requestPath(binding.directory(),binding.request());
        var permissions=java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        var attributes=Files.getFileStore(file.getParent()).supportsFileAttributeView("posix")?new java.nio.file.attribute.FileAttribute<?>[]{permissions}:new java.nio.file.attribute.FileAttribute<?>[0];
        try(FileChannel channel=FileChannel.open(file,Set.of(StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS),attributes)){
            ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())channel.write(buffer);channel.force(true);
        }finally{java.util.Arrays.fill(bytes,(byte)0);}
        LifecycleWireV1.need(LifecycleWireV1.sha(file).equals(expectedDigest),"LIFECYCLE_CONFIGURATION");
        return REQUEST_FORMAT+";"+binding.request()+";"+expectedDigest;
    }
    static String readRequest(String options) throws Exception {
        String[] token=options.split(";",-1);
        LifecycleWireV1.need(token.length==3&&REQUEST_FORMAT.equals(token[0])&&LifecycleWireV1.uuid(token[1])&&LifecycleWireV1.hash(token[2]),"LIFECYCLE_INPUT");
        String directory=System.getProperty("idms.lifecycle.directory");
        LifecycleWireV1.need(directory!=null,"LIFECYCLE_DIRECTORY");
        Path file=requestPath(directory,token[1]);
        var before=Files.readAttributes(file,java.nio.file.attribute.BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        LifecycleWireV1.need(before.isRegularFile()&&!before.isSymbolicLink()&&before.fileKey()!=null&&before.size()>0&&before.size()<=REQUEST_MAX_BYTES,"LIFECYCLE_FILE");
        if(Files.getFileStore(file).supportsFileAttributeView("unix"))LifecycleWireV1.need(((Number)Files.getAttribute(file,"unix:nlink",LinkOption.NOFOLLOW_LINKS)).longValue()==1,"LIFECYCLE_FILE");
        byte[] bytes=new byte[(int)before.size()];
        try(FileChannel channel=FileChannel.open(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){
            ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining()){int n=channel.read(buffer);LifecycleWireV1.need(n>0,"LIFECYCLE_FILE");}
            LifecycleWireV1.need(channel.read(ByteBuffer.allocate(1))==-1,"LIFECYCLE_FILE");
            var after=Files.readAttributes(file,java.nio.file.attribute.BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
            LifecycleWireV1.need(after.isRegularFile()&&!after.isSymbolicLink()&&after.size()==before.size()&&java.util.Objects.equals(before.fileKey(),after.fileKey())&&before.lastModifiedTime().equals(after.lastModifiedTime())&&before.creationTime().equals(after.creationTime()),"LIFECYCLE_FILE");
            String digest=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
            LifecycleWireV1.need(java.security.MessageDigest.isEqual(digest.getBytes(StandardCharsets.US_ASCII),token[2].getBytes(StandardCharsets.US_ASCII)),"LIFECYCLE_CONFIGURATION");
            String body=StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            String[] parts=body.split(";",-1);LifecycleWireV1.need(parts.length==5&&LifecycleWireV1.parse(parts[0]).request().equals(token[1]),"LIFECYCLE_INPUT");
            return body;
        }finally{java.util.Arrays.fill(bytes,(byte)0);}
    }
    public static synchronized void agentmain(String options,Instrumentation ignored) throws Exception {
        String[] v=readRequest(options).split(";",-1);LifecycleWireV1.need(v.length==5,"LIFECYCLE_INPUT");
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

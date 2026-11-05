package com.idms.workflow;

import com.zaxxer.hikari.HikariDataSource;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Database transport policy for the existing loopback-only workflow profile. */
final class WorkflowDataSources {
    private static final Pattern URL = Pattern.compile("jdbc:postgresql://127\\.0\\.0\\.1:([1-9][0-9]{0,4})/([a-z0-9_]{1,63})");
    static final int CERTIFICATE_FILE_LIMIT = 1024 * 1024;
    static final int LOGIN_TIMEOUT_SECONDS = 10;
    private WorkflowDataSources() {}

    static void requireLocalUrl(String value) {
        var match = URL.matcher(value == null ? "" : value);
        if (!match.matches() || Integer.parseInt(match.group(1)) > 65535)
            throw new IllegalArgumentException("WORKFLOW_DATABASE_URL_INVALID");
    }

    static Path defaultCertificateDirectory(String os, String appData, String userHome) {
        boolean windows = os.toLowerCase(Locale.ROOT).contains("windows");
        String parent = windows ? appData : userHome;
        if (parent == null || parent.isBlank()) throw new IllegalArgumentException("WORKFLOW_DATABASE_CERTIFICATE_DIRECTORY_INVALID");
        Path root = Path.of(parent);
        if (!root.isAbsolute() || !root.equals(root.normalize())) throw new IllegalArgumentException("WORKFLOW_DATABASE_CERTIFICATE_DIRECTORY_INVALID");
        return root.resolve(windows ? "postgresql" : ".postgresql");
    }

    static void requireBoundedRegularFileIfPresent(Path path) throws IOException {
        BasicFileAttributes attributes;
        try { attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
        catch (NoSuchFileException absent) { return; }
        if (!attributes.isRegularFile() || attributes.isSymbolicLink() || attributes.size() < 1 || attributes.size() > CERTIFICATE_FILE_LIMIT)
            throw new IOException("WORKFLOW_DATABASE_CERTIFICATE_FILE_INVALID");
        for (Path parent = path.getParent(); parent != null; parent = parent.getParent())
            if (Files.isSymbolicLink(parent)) throw new IOException("WORKFLOW_DATABASE_CERTIFICATE_FILE_INVALID");
        try (var input = Files.newByteChannel(path, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            var buffer = ByteBuffer.allocate(8192);
            long bytes = 0;
            while (input.read(buffer) != -1) {
                bytes += buffer.position();
                if (bytes > CERTIFICATE_FILE_LIMIT) throw new IOException("WORKFLOW_DATABASE_CERTIFICATE_FILE_INVALID");
                buffer.clear();
            }
            if (bytes < 1) throw new IOException("WORKFLOW_DATABASE_CERTIFICATE_FILE_INVALID");
        }
    }

    static HikariDataSource create(String url, String user, String password, String poolName, int maximumPoolSize) throws IOException {
        requireLocalUrl(url);
        Path certs = defaultCertificateDirectory(System.getProperty("os.name"), System.getenv("APPDATA"), System.getProperty("user.home"));
        try {
            for (String name : new String[]{"root.crt", "postgresql.crt", "postgresql.pk8"})
                requireBoundedRegularFileIfPresent(certs.resolve(name));
        } catch (IOException | RuntimeException rejected) {
            throw new IOException("WORKFLOW_DATABASE_CERTIFICATE_FILE_INVALID");
        }
        var source = new HikariDataSource();
        source.setJdbcUrl(url); source.setUsername(user); source.setPassword(password);
        source.setPoolName(poolName); source.setMaximumPoolSize(maximumPoolSize);
        source.addDataSourceProperty("loginTimeout", Integer.toString(LOGIN_TIMEOUT_SECONDS));
        source.addDataSourceProperty("connectTimeout", "5");
        // Preserve the existing SSL negotiation and certificate verification.
        return source;
    }
}

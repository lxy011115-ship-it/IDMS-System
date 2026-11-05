package com.idms.workflow;

import static org.junit.jupiter.api.Assertions.*;
import java.io.IOException;
import java.nio.file.*;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

class WorkflowDataSourcesTest {
    @TempDir Path temporary;

    @Test void existingLocalDatabaseBindingsRemainValid() {
        for (String port : new String[]{"1", "5432", "65535"})
            assertDoesNotThrow(() -> WorkflowDataSources.requireLocalUrl("jdbc:postgresql://127.0.0.1:"+port+"/idms_workflow"));
    }

    @Test void configurationCannotSelectCertificateFilesFactoriesOrOtherHostsThroughTheUrl() {
        for (String value : new String[]{"", "jdbc:postgresql://localhost:5432/idms", "jdbc:postgresql://127.0.0.1:0/idms", "jdbc:postgresql://127.0.0.1:65536/idms", "jdbc:postgresql://127.0.0.1:5432/idms?sslrootcert=/dev/zero", "jdbc:postgresql://127.0.0.1:5432/idms?sslfactory=unexpected", "jdbc:postgresql://127.0.0.1:5432/idms#fragment", "jdbc:postgresql://127.0.0.1:5432/idms%3Fsslcert=x", "jdbc:postgresql://127.0.0.1:5432/idms/extra"})
            assertThrows(IllegalArgumentException.class, () -> WorkflowDataSources.requireLocalUrl(value));
        assertThrows(IllegalArgumentException.class, () -> WorkflowDataSources.requireLocalUrl(null));
    }

    @Test void defaultPathsMatchTheDriversWindowsAndUnixConventions() {
        String root = temporary.toString();
        assertEquals(temporary.resolve("postgresql"), WorkflowDataSources.defaultCertificateDirectory("Windows 11", root, null));
        assertEquals(temporary.resolve(".postgresql"), WorkflowDataSources.defaultCertificateDirectory("Linux", null, root));
        assertThrows(IllegalArgumentException.class, () -> WorkflowDataSources.defaultCertificateDirectory("Windows", null, root));
        assertThrows(IllegalArgumentException.class, () -> WorkflowDataSources.defaultCertificateDirectory("Linux", null, "relative"));
    }

    @Test void missingOrBoundedRegularFilesAreAcceptedWithoutCreatingOrChangingThem() throws Exception {
        Path missing = temporary.resolve("missing.crt");
        WorkflowDataSources.requireBoundedRegularFileIfPresent(missing);
        assertFalse(Files.exists(missing));
        Path regular = temporary.resolve("bounded.crt");
        byte[] bytes = new byte[]{1,2,3};
        Files.write(regular, bytes);
        WorkflowDataSources.requireBoundedRegularFileIfPresent(regular);
        assertArrayEquals(bytes, Files.readAllBytes(regular));
    }

    @Test void emptyDirectoriesAndOversizedFilesFailBeforeDriverParsing() throws Exception {
        assertThrows(IOException.class, () -> WorkflowDataSources.requireBoundedRegularFileIfPresent(temporary));
        Path file = Files.createFile(temporary.resolve("invalid.crt"));
        assertThrows(IOException.class, () -> WorkflowDataSources.requireBoundedRegularFileIfPresent(file));
        Files.write(file, new byte[WorkflowDataSources.CERTIFICATE_FILE_LIMIT + 1]);
        assertThrows(IOException.class, () -> WorkflowDataSources.requireBoundedRegularFileIfPresent(file));
    }

    @Test void eachPoolGetsABoundedLoginWithoutDisablingOrReplacingTls() throws Exception {
        try (var pool = WorkflowDataSources.create("jdbc:postgresql://127.0.0.1:5432/idms_workflow", "unused", "", "transport-policy-test", 2)) {
            var properties = org.postgresql.Driver.parseURL(pool.getJdbcUrl(), pool.getDataSourceProperties());
            assertNotNull(properties);
            assertEquals(10, org.postgresql.PGProperty.LOGIN_TIMEOUT.getInt(properties));
            assertEquals(5, org.postgresql.PGProperty.CONNECT_TIMEOUT.getInt(properties));
            assertFalse(pool.getDataSourceProperties().containsKey("sslmode"));
            assertFalse(pool.getDataSourceProperties().containsKey("sslfactory"));
            assertNull(pool.getHikariPoolMXBean());
        }
    }

    @Test @EnabledOnOs(OS.LINUX)
    void unixDevicesFifosAndLinksAreRejectedBeforeAnyBlockingRead() throws Exception {
        Path fifo = temporary.resolve("certificate-fifo");
        assertEquals(0, new ProcessBuilder("mkfifo", fifo.toString()).start().waitFor());
        Path file = Files.write(temporary.resolve("ordinary.crt"), new byte[]{1});
        Path link = Files.createSymbolicLink(temporary.resolve("linked.crt"), file);
        assertTimeout(Duration.ofSeconds(3), () -> {
            for (Path path : new Path[]{Path.of("/dev/zero"), fifo, link})
                assertThrows(IOException.class, () -> WorkflowDataSources.requireBoundedRegularFileIfPresent(path));
        });
    }
}

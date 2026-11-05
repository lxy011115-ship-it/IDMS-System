package com.idms.workflow;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.json.JsonMapper;

class WorkflowJsonTest {
    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void canonicalBytesAndHashesMatchTheOriginalTwentyOneNodeVectors() throws Exception {
        try (var input = getClass().getResourceAsStream("/canonical-vectors.json")) {
            assertNotNull(input);
            var vectors = json.readTree(input);
            assertEquals(21, vectors.size());
            for (var vector : vectors) {
                var actual = WorkflowJson.canonical(json, json.readTree(vector.path("input").asText()));
                assertEquals(vector.path("canonical").asText(), actual, vector.path("kind").asText());
                var digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(actual.getBytes(StandardCharsets.UTF_8)));
                assertEquals(vector.path("sha256").asText(), digest);
            }
        }
    }

    @Test
    void cancellationReaderStillRejectsDuplicateFieldsAtAnyDepth() {
        var reader = json.reader().with(StreamReadFeature.STRICT_DUPLICATE_DETECTION);
        assertThrows(Exception.class, () -> reader.readTree("{\"format\":1,\"format\":2}"));
        assertThrows(Exception.class, () -> reader.readTree("{\"envelope\":{\"actor\":1,\"actor\":2}}"));
    }

    @Test
    void ordinaryStartupRemainsValidationOnlyAndEngineVersionIsActual() {
        assertEquals("runtime", WorkflowStartup.mode(null));
        assertEquals("runtime", WorkflowStartup.mode("runtime"));
        assertEquals("initialize", WorkflowStartup.mode("initialize"));
        assertThrows(IllegalStateException.class, () -> WorkflowStartup.mode("upgrade"));
        assertEquals(org.flowable.engine.ProcessEngine.VERSION, WorkflowStartup.engineVersion());
        // Flowable 8.0.0 publishes the four-part engine/schema version unchanged.
        assertEquals("8.0.0.0", WorkflowStartup.engineVersion());
    }
}

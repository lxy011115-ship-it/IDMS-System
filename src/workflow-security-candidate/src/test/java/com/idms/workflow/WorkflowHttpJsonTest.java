package com.idms.workflow;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Properties;
import jakarta.servlet.ServletInputStream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter;
import org.springframework.mock.http.MockHttpInputMessage;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class WorkflowHttpJsonTest {
    private ApplicationContextRunner context() throws Exception {
        Properties properties = new Properties();
        try (var input = getClass().getResourceAsStream("/application.properties")) {
            assertNotNull(input);
            properties.load(input);
        }
        assertNotNull(Class.forName(properties.getProperty("spring.autoconfigure.exclude")));
        String[] jacksonProperties = properties.stringPropertyNames().stream()
            .filter(key -> key.startsWith("spring.jackson."))
            .map(key -> key + "=" + properties.getProperty(key)).toArray(String[]::new);
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(JacksonAutoConfiguration.class))
            .withUserConfiguration(WorkflowJacksonConfiguration.class)
            .withPropertyValues(jacksonProperties);
    }

    private JsonNode read(JacksonJsonHttpMessageConverter converter, String body) throws Exception {
        var input = new MockHttpInputMessage(body.getBytes(StandardCharsets.UTF_8));
        input.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        return (JsonNode) converter.read(JsonNode.class, input);
    }

    @Test
    void commandBodyRejectsAnOversizedDeclarationBeforeReading() throws Exception {
        context().run(ctx -> {
            var converter = new JacksonJsonHttpMessageConverter(ctx.getBean(JsonMapper.class));
            var request = new MockHttpServletRequest() {
                @Override public long getContentLengthLong() { return 1024L * 1024 + 1; }
                @Override public ServletInputStream getInputStream() { throw new AssertionError("Body was read"); }
            };
            var failure = assertThrows(ResponseStatusException.class, () -> WorkflowController.readCommandBody(request, converter));
            assertEquals(413, failure.getStatusCode().value());
        });
    }

    @Test
    void commandBodyEnforcesTheByteLimitWithNoDeclaredLength() throws Exception {
        context().run(ctx -> {
            var converter = new JacksonJsonHttpMessageConverter(ctx.getBean(JsonMapper.class));
            var request = new MockHttpServletRequest() {
                @Override public long getContentLengthLong() { return -1; }
            };
            request.setContentType("application/vnd.idms+json");
            byte[] limit = new byte[1024 * 1024];
            Arrays.fill(limit, (byte) ' ');
            limit[limit.length - 2] = '{';
            limit[limit.length - 1] = '}';
            request.setContent(limit);
            assertTrue(WorkflowController.readCommandBody(request, converter).isObject());

            request.setContent(Arrays.copyOf(limit, limit.length + 1));
            var failure = assertThrows(ResponseStatusException.class, () -> WorkflowController.readCommandBody(request, converter));
            assertEquals(413, failure.getStatusCode().value());
        });
    }

    @Test
    void configuredHttpConverterPreservesAllTwentyOneCanonicalVectors() throws Exception {
        context().run(ctx -> {
            assertNull(ctx.getStartupFailure());
            var mapper = ctx.getBean(JsonMapper.class);
            var converter = new JacksonJsonHttpMessageConverter(mapper);
            try (var input = getClass().getResourceAsStream("/canonical-vectors.json")) {
                assertNotNull(input);
                for (var vector : mapper.readTree(input)) {
                    var node = read(converter, vector.path("input").asText());
                    assertEquals(vector.path("canonical").asText(), WorkflowJson.canonical(mapper, node));
                }
            }
        });
    }

    @Test
    void actualHttpConverterRejectsDuplicateFieldsAndUnknownRecordFields() throws Exception {
        context().run(ctx -> {
            var mapper = ctx.getBean(JsonMapper.class);
            var converter = new JacksonJsonHttpMessageConverter(mapper);
            assertThrows(Exception.class, () -> read(converter, "{\"action\":\"create\",\"action\":\"start\"}"));
            assertThrows(Exception.class, () -> read(converter, "{\"actor\":{\"id\":\"a\",\"id\":\"b\"}}"));
            assertThrows(Exception.class, () -> mapper.readValue(
                "{\"id\":\"a\",\"type\":\"USER\",\"permissions\":[],\"unexpected\":true}",
                WorkflowController.Actor.class));
        });
    }

    @Test
    void commandDecoderRejectsCoercionMissingAndUnexpectedFields() throws Exception {
        context().run(ctx -> {
            var mapper = ctx.getBean(JsonMapper.class);
            var converter = new JacksonJsonHttpMessageConverter(mapper);
            ObjectNode valid;
            try (var input = getClass().getResourceAsStream("/canonical-vectors.json")) {
                var fixture = mapper.readTree(input).get(0);
                valid = (ObjectNode) read(converter, fixture.path("input").asText());
            }
            valid.put("requestDigest", "a".repeat(64));
            assertDoesNotThrow(() -> WorkflowJson.requireCommand(valid));
            var numericString = valid.deepCopy(); numericString.put("expectedVersion", "1");
            var fraction = valid.deepCopy(); fraction.put("expectedVersion", 1.5);
            var overflow = valid.deepCopy(); overflow.put("expectedVersion", 2147483648L);
            var missing = valid.deepCopy(); missing.remove("actor");
            var extra = valid.deepCopy(); extra.put("unexpected", true);
            var wrongActor = valid.deepCopy(); ((ObjectNode) wrongActor.get("actor")).put("id", 1);
            for (var invalid : new JsonNode[] {numericString, fraction, overflow, missing, extra, wrongActor}) {
                assertThrows(IllegalArgumentException.class, () -> WorkflowJson.requireCommand(invalid));
            }
        });
    }
}

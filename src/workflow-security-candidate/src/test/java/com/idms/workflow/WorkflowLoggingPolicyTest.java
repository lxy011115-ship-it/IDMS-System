package com.idms.workflow;

import static org.junit.jupiter.api.Assertions.*;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.sift.MDCBasedDiscriminator;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.util.Map;
import org.junit.jupiter.api.Test;

class WorkflowLoggingPolicyTest {
    @Test void maintainedLoggingRejectsMdcPathAndAddressInjectionWithoutChangingNormalKeys() {
        var context = new LoggerContext();
        var discriminator = new MDCBasedDiscriminator();
        discriminator.setContext(context);
        discriminator.setKey("tenant");
        discriminator.setDefaultValue("unassigned");
        discriminator.start();
        try {
            var normal = new LoggingEvent(); normal.setMDCPropertyMap(Map.of("tenant", "acme"));
            assertEquals("acme", discriminator.getDiscriminatingValue(normal));
            for (String key : new String[]{"../outside", "a/b", "a\\b", "a..b", "${variable}", "user@host", "x".repeat(65)}) {
                var event = new LoggingEvent(); event.setMDCPropertyMap(Map.of("tenant", key));
                assertEquals("unassigned", discriminator.getDiscriminatingValue(event));
            }
        } finally { discriminator.stop(); context.stop(); }
    }
}

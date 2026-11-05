package com.idms.workflow;

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.core.StreamReadFeature;

@Configuration(proxyBeanMethods = false)
class WorkflowJacksonConfiguration {
    @Bean
    JsonMapperBuilderCustomizer rejectDuplicateWorkflowProperties() {
        return builder -> builder.enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION);
    }
}

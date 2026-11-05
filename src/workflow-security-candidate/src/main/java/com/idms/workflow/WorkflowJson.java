package com.idms.workflow;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Preserve the reviewed V1 canonical bytes across the Jackson package migration. */
final class WorkflowJson {
    private WorkflowJson() {}

    static void requireCommand(JsonNode node) {
        Set<String> required = Set.of("commandId", "requestDigest", "entityId", "action", "expectedVersion", "actor");
        Set<String> optional = Set.of("assignee", "evidenceDigest", "decision", "comment", "correlationId");
        if (!node.isObject() || !node.propertyNames().containsAll(required)) throw new IllegalArgumentException();
        for (String key : node.propertyNames()) {
            if (!required.contains(key) && !optional.contains(key)) throw new IllegalArgumentException();
        }
        for (String key : List.of("commandId", "requestDigest", "entityId", "action")) {
            if (!node.path(key).isTextual()) throw new IllegalArgumentException();
        }
        JsonNode version = node.path("expectedVersion");
        if (!version.isIntegralNumber() || !version.canConvertToInt() || version.intValue() < 1) {
            throw new IllegalArgumentException();
        }
        for (String key : optional) {
            JsonNode value = node.get(key);
            if (value != null && !value.isNull() && !value.isTextual()) throw new IllegalArgumentException();
        }
        JsonNode actor = node.path("actor");
        if (!actor.isObject() || !Set.copyOf(actor.propertyNames()).equals(Set.of("id", "type", "permissions"))
            || !actor.path("id").isTextual() || !actor.path("type").isTextual()
            || !actor.path("permissions").isArray() || actor.path("permissions").size() > 64) {
            throw new IllegalArgumentException();
        }
        for (JsonNode permission : actor.path("permissions")) {
            if (!permission.isTextual() || permission.asText().length() > 80) throw new IllegalArgumentException();
        }
    }

    static String canonical(ObjectMapper json, JsonNode node) {
        if (node.isObject()) {
            List<String> keys = new ArrayList<>(node.propertyNames());
            Collections.sort(keys);
            List<String> members = new ArrayList<>();
            for (String key : keys) {
                members.add(json.writeValueAsString(key) + ":" + canonical(json, node.get(key)));
            }
            return "{" + String.join(",", members) + "}";
        }
        if (node.isArray()) {
            List<String> members = new ArrayList<>();
            for (JsonNode child : node) members.add(canonical(json, child));
            return "[" + String.join(",", members) + "]";
        }
        return json.writeValueAsString(node);
    }
}

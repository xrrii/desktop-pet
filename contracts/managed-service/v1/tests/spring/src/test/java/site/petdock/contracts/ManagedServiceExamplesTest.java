package site.petdock.contracts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

/** 使用 Jackson 验证 Java/Spring 消费端的固定契约样例。 */
class ManagedServiceExamplesTest {
    private final ObjectMapper mapper = new ObjectMapper();

    /** 从测试资源读取样例，避免依赖 Maven 启动目录。 */
    private JsonNode read(String name) throws IOException {
        try (InputStream stream = getClass().getResourceAsStream("/" + name)) {
            assertNotNull(stream, "缺少固定样例: " + name);
            return mapper.readTree(stream);
        }
    }

    /** 验证字段、枚举、Token TTL 和稳定序列化。 */
    @Test
    void examplesAreCompatible() throws IOException {
        JsonNode capabilities = read("capability-settings.json");
        assertEquals(1, capabilities.path("version").asInt());
        assertEquals("managed", capabilities.path("capabilities").path("chat").path("effectiveSource").asText());
        assertEquals("user_disabled", capabilities.path("capabilities").path("vision").path("reason").asText());
        JsonNode claims = read("runtime-token-claims.json");
        assertEquals("https://account.petdock.site", claims.path("iss").asText());
        assertEquals(15 * 60, claims.path("exp").asLong() - claims.path("iat").asLong());
        assertEquals(List.of("chat", "embedding"), mapper.convertValue(claims.path("capabilities"), List.class));
        JsonNode usage = read("usage-event.json");
        assertEquals("settled", usage.path("status").asText());
        assertEquals(600, usage.path("inputUnits").asInt() + usage.path("outputUnits").asInt());
        assertEquals(64, usage.path("requestFingerprint").asText().length());
        assertTrue(usage.path("reason").isNull());
        JsonNode stream = read("chat-stream-event.json");
        assertEquals("delta", stream.path("type").asText());
        assertEquals(1, stream.path("sequence").asInt());
        List<JsonNode> streamExamples = List.of(
                read("chat-stream-event.json"),
                read("chat-stream-tool-call.json"),
                read("chat-stream-usage.json"),
                read("chat-stream-completed.json"),
                read("chat-stream-error.json"));
        assertEquals(List.of("delta", "tool_call", "usage", "completed", "error"), streamExamples.stream().map(item -> item.path("type").asText()).toList());
        assertEquals(List.of(1, 2, 3, 4), streamExamples.subList(0, 4).stream().map(item -> item.path("sequence").asInt()).toList());
        assertEquals(1, streamExamples.subList(0, 4).stream().map(item -> item.path("traceId").asText()).distinct().count());
        assertEquals(1, streamExamples.subList(0, 4).stream().map(item -> item.path("requestId").asText()).distinct().count());
        assertEquals(30, read("chat-stream-error.json").path("retryAfterSeconds").asInt());
        JsonNode featureFlags = read("feature-flags.json");
        assertTrue(featureFlags.path("managed_login_enabled").asBoolean());
        assertFalse(featureFlags.path("managed_chat_enabled").asBoolean());
        JsonNode chatRequest = read("chat-request.json");
        assertEquals("chat-standard", chatRequest.path("logicalModel").asText());
        assertTrue(chatRequest.path("stream").asBoolean());
        assertEquals("read_text_file", chatRequest.path("tools").path(0).path("function").path("name").asText());
        JsonNode reservation = read("usage-reservation-request.json");
        assertEquals("chat", reservation.path("capability").asText());
        assertEquals(64, reservation.path("requestFingerprint").asText().length());
        JsonNode reservationResult = read("usage-reservation-response.json");
        assertEquals("reserved", reservationResult.path("status").asText());
        assertFalse(reservationResult.path("replayed").asBoolean());
        JsonNode settlement = read("usage-settlement-request.json");
        assertEquals(600, settlement.path("inputUnits").asInt() + settlement.path("outputUnits").asInt());
        assertEquals("settled", read("usage-terminal-response.json").path("status").asText());
        JsonNode webUsage = read("web-usage-summary.json");
        assertEquals("tokens", webUsage.path("chat").path("unit").asText());
        assertEquals(100000, webUsage.path("chat").path("used").asInt() + webUsage.path("chat").path("remaining").asInt());
        JsonNode anonymousWebSession = read("web-session-anonymous.json");
        assertEquals(1, anonymousWebSession.path("version").asInt());
        assertFalse(anonymousWebSession.path("authenticated").asBoolean());
        assertTrue(anonymousWebSession.path("expiresAt").isNull());
        assertTrue(anonymousWebSession.path("user").isNull());
        JsonNode authenticatedWebSession = read("web-session-authenticated.json");
        assertTrue(authenticatedWebSession.path("authenticated").asBoolean());
        assertEquals("demo_user", authenticatedWebSession.path("user").path("username").asText());
        assertTrue(authenticatedWebSession.path("user").path("passwordEnabled").asBoolean());
        JsonNode inactiveEntitlement = read("entitlement-inactive.json");
        assertEquals("inactive", inactiveEntitlement.path("status").asText());
        assertTrue(inactiveEntitlement.path("billingMode").isNull());
        JsonNode subscriptionEntitlement = read("entitlement-subscription.json");
        assertEquals("subscription", subscriptionEntitlement.path("billingMode").asText());
        assertEquals("quota", subscriptionEntitlement.path("capabilities").path("chat").path("quotaMode").asText());
        assertTrue(subscriptionEntitlement.path("capabilities").path("chat").path("remaining").asLong() >= 0);
        JsonNode meteredEntitlement = read("entitlement-pay-as-you-go.json");
        assertEquals("pay_as_you_go", meteredEntitlement.path("billingMode").asText());
        assertTrue(meteredEntitlement.path("plan").isNull());
        assertTrue(meteredEntitlement.path("expiresAt").isNull());
        assertEquals("metered", meteredEntitlement.path("capabilities").path("chat").path("quotaMode").asText());
        assertTrue(meteredEntitlement.path("capabilities").path("chat").path("remaining").isNull());
        for (String name : List.of("runtime-token-header.json", "request-context.json", "managed-auth-refresh-event.json", "managed-auth-result.json")) {
            JsonNode value = read(name);
            assertTrue(value.isObject() && value.size() > 0);
            assertEquals(value, mapper.readTree(mapper.writeValueAsBytes(value)));
        }
        for (String name : List.of(
                "web-session-anonymous.json",
                "web-session-authenticated.json",
                "entitlement-inactive.json",
                "entitlement-subscription.json",
                "entitlement-pay-as-you-go.json",
                "feature-flags.json",
                "chat-request.json",
                "chat-stream-tool-call.json",
                "chat-stream-usage.json",
                "chat-stream-completed.json",
                "chat-stream-error.json",
                "usage-reservation-request.json",
                "usage-reservation-response.json",
                "usage-settlement-request.json",
                "usage-terminal-response.json",
                "web-usage-summary.json")) {
            JsonNode value = read(name);
            assertTrue(value.isObject() && value.size() > 0);
            assertEquals(value, mapper.readTree(mapper.writeValueAsBytes(value)));
        }
    }
}

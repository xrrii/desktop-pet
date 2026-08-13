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
        JsonNode stream = read("chat-stream-event.json");
        assertEquals("delta", stream.path("type").asText());
        assertEquals(1, stream.path("sequence").asInt());
        for (String name : List.of("runtime-token-header.json", "request-context.json", "managed-auth-refresh-event.json", "managed-auth-result.json")) {
            JsonNode value = read(name);
            assertTrue(value.isObject() && value.size() > 0);
            assertEquals(value, mapper.readTree(mapper.writeValueAsBytes(value)));
        }
    }
}

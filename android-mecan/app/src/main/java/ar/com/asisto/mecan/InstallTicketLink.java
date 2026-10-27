// Asisto | Validación del enlace de instalación de Mecan | 2026-10-27
package ar.com.asisto.mecan;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

final class InstallTicketLink {
    static String fromReferrer(String referrer) {
        if (referrer == null || referrer.length() > 1024) return null;
        String id = null, code = null;
        try {
            for (String pair : referrer.split("&")) {
                String[] parts = pair.split("=", 2);
                String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8.name());
                String value = parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8.name()) : "";
                if ("mecan_ticket".equals(key)) { if (id != null) return null; id = value; }
                if ("mecan_code".equals(key)) { if (code != null) return null; code = value; }
            }
        } catch (Exception ignored) { return null; }
        if (id == null || !id.matches("[a-fA-F0-9]{24}") || code == null || !code.matches("[A-Za-z0-9_-]{43}")) return null;
        return "https://asistobot.com.ar/customer-app/MCN?view=ticket&claim=" + id + "#code=" + code;
    }
}

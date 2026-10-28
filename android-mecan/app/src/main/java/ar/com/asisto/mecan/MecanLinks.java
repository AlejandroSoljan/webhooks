package ar.com.asisto.mecan;

import java.net.URI;
import java.util.Locale;

final class MecanLinks {
    static String canonicalTicketUrl(String value) {
        if (value == null || value.length() > 4096) return null;
        try {
            URI uri = new URI(value);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null ||
                (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            if (!(host.equals("asistobot.com.ar") || host.equals("www.asistobot.com.ar") ||
                  host.equals("asisto.com.ar") || host.equals("www.asisto.com.ar"))) return null;
            String path = uri.getRawPath();
            if (path == null || !(path.equals("/customer-app/MCN") || path.startsWith("/customer-app/MCN/"))) return null;
            return "https://asistobot.com.ar" + path +
                (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()) +
                (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
        } catch (Exception ignored) { return null; }
    }
}

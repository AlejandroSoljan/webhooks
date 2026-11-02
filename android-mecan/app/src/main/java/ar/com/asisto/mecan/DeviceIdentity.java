package ar.com.asisto.mecan;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Notification identity only; must never grant access to tickets or accounts. */
final class DeviceIdentity {
    static String key(String androidId, String packageName) {
        if (androidId == null || !androidId.matches("(?i)[0-9a-f]{16}")
                || "9774d56d682e549c".equalsIgnoreCase(androidId)
                || "0000000000000000".equals(androidId)) return "";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                ("asisto-notifications-v1:" + packageName + ":" + androidId.toLowerCase(java.util.Locale.ROOT))
                    .getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte value : digest) out.append(String.format(java.util.Locale.ROOT,"%02x", value & 255));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) { return ""; }
    }
}

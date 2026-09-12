// Asisto Android | Version: 1.1.4 | Fecha: 2026-09-11
package ar.com.asistobot.scanner;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class PushRegistration {
    private static final String REGISTER_URL = "https://asistobot.com.ar/api/customer-app/DEMO_FERRETERIA/devices";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final AtomicBoolean TOKEN_REQUEST_RUNNING = new AtomicBoolean(false);
    private static final AtomicBoolean REGISTER_RUNNING = new AtomicBoolean(false);
    private static int retryAttempt = 0;

    private PushRegistration() { }

    static String installId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("asisto_push", Context.MODE_PRIVATE);
        String value = prefs.getString("install_id", "");
        if (value == null || value.isEmpty()) {
            value = UUID.randomUUID().toString();
            prefs.edit().putString("install_id", value).apply();
        }
        return value;
    }

    static void adoptInstallId(Context context, String value) {
        if (value == null || !value.matches("[A-Za-z0-9._-]{8,120}")) return;
        SharedPreferences prefs = context.getSharedPreferences("asisto_push", Context.MODE_PRIVATE);
        if (prefs.getString("install_id", "").isEmpty()) {
            prefs.edit().putString("install_id", value).apply();
        }
    }

    static void ensure(Context context) {
        Context app = context.getApplicationContext();
        if (!TOKEN_REQUEST_RUNNING.compareAndSet(false, true)) return;
        FirebaseMessaging.getInstance().getToken()
            .addOnSuccessListener(token -> {
                TOKEN_REQUEST_RUNNING.set(false);
                if (token == null || token.trim().isEmpty()) scheduleEnsure(app);
                else register(app, token);
            })
            .addOnFailureListener(error -> {
                TOKEN_REQUEST_RUNNING.set(false);
                scheduleEnsure(app);
            });
    }

    static void register(Context context, String token) {
        Context app = context.getApplicationContext();
        if (token == null || token.trim().isEmpty()) {
            scheduleEnsure(app);
            return;
        }
        if (!REGISTER_RUNNING.compareAndSet(false, true)) return;
        IO.execute(() -> {
            boolean ok = false;
            HttpURLConnection connection = null;
            try {
                JSONObject payload = new JSONObject();
                payload.put("installId", installId(app));
                payload.put("pushToken", token);
                payload.put("deviceName", (Build.MANUFACTURER + " " + Build.MODEL).trim());
                payload.put("registrationSource", "android-native");
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection = (HttpURLConnection) new URL(REGISTER_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("X-Asisto-Device-Name", (Build.MANUFACTURER + " " + Build.MODEL).trim());
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                ok = status >= 200 && status < 300;
                if (ok) {
                    app.getSharedPreferences("asisto_push", Context.MODE_PRIVATE).edit()
                        .putString("push_token", token)
                        .putLong("registered_at", System.currentTimeMillis())
                        .apply();
                    retryAttempt = 0;
                }
            } catch (Exception ignored) {
            } finally {
                if (connection != null) connection.disconnect();
                REGISTER_RUNNING.set(false);
                if (!ok) scheduleEnsure(app);
            }
        });
    }

    private static void scheduleEnsure(Context context) {
        int attempt = Math.min(retryAttempt++, 6);
        long delay = Math.min(300000L, 5000L * (1L << attempt));
        MAIN.removeCallbacksAndMessages(PushRegistration.class);
        MAIN.postAtTime(() -> ensure(context), PushRegistration.class,
            android.os.SystemClock.uptimeMillis() + delay);
    }
}

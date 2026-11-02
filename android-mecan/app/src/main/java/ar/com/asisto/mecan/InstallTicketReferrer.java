// Asisto | Recuperación persistente del turno tras instalación | 2026-10-29
package ar.com.asisto.mecan;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import java.io.File;
import java.io.IOException;

final class InstallTicketReferrer {
    interface Callback { void ready(String url); }
    private static final String PREFS = "mecan_install_ticket";
    private static final String PENDING = "pending_url";
    private static final String COMPLETED = "completed_url";

    private static synchronized SharedPreferences preferences(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // Restored preferences cannot suppress recovery on a new installation.
        File marker = new File(context.getNoBackupFilesDir(), "mecan-install-recovery-v2");
        if (!marker.exists()) {
            prefs.edit().clear().commit();
            try { marker.createNewFile(); } catch (IOException ignored) { }
        }
        return prefs;
    }

    static String ticketUrl(String referrer) { return InstallTicketLink.fromReferrer(referrer); }

    static void diagnostic(Context context, String status) {
        preferences(context).edit().putString("recovery_status", status).apply();
    }

    static String diagnostic(Context context) {
        return preferences(context).getString("recovery_status", "not_started");
    }

    static boolean beginClipboardCheck(Context context) {
        SharedPreferences prefs = preferences(context);
        if (prefs.contains(COMPLETED) || prefs.getBoolean("clipboard_checked", false)) return false;
        prefs.edit().putBoolean("clipboard_checked", true).commit();
        return true;
    }

    static String acceptClipboard(Context context, String text) {
        String url = InstallTicketLink.fromClipboard(text);
        SharedPreferences prefs = preferences(context);
        if (url == null || url.equals(prefs.getString(COMPLETED, null))) return null;
        prefs.edit().putString(PENDING, url).putString("recovery_status", "clipboard_received").commit();
        return url;
    }

    /** May show Home first and deliver a late ticket without restarting the app. */
    static Runnable resolve(Context context, Callback callback) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = preferences(app);
        String pending = prefs.getString(PENDING, null);
        if (pending != null) { diagnostic(app, "pending"); callback.ready(pending); return () -> {}; }
        diagnostic(app, "connecting");
        Handler handler = new Handler(Looper.getMainLooper());
        InstallRecoveryState state = new InstallRecoveryState();
        class Request {
            InstallReferrerClient client;
            boolean stopped;
            int attempts, generation;
            void home() { if (!stopped && state.showHome()) callback.ready(null); }
            void closeClient() {
                if (client != null) { try { client.endConnection(); } catch (RuntimeException ignored) {} client = null; }
            }
            void stop() { stopped = true; generation++; handler.removeCallbacksAndMessages(null); closeClient(); }
            void retry(int attempt) {
                if (stopped || attempt != generation) return;
                generation++;
                closeClient();
                home();
                PushRegistration.ensure(app);
                if (attempts < 4) handler.postDelayed(this::start, attempts * 2000L);
            }
            void start() {
                if (stopped) return;
                attempts++;
                final int attempt = ++generation;
                handler.postDelayed(() -> retry(attempt), 15000);
                try {
                    client = InstallReferrerClient.newBuilder(app).build();
                    client.startConnection(new InstallReferrerStateListener() {
                        @Override public void onInstallReferrerSetupFinished(int response) {
                            handler.post(() -> {
                                if (stopped || attempt != generation) return;
                                if (response != InstallReferrerClient.InstallReferrerResponse.OK) { diagnostic(app, "play_response_" + response); retry(attempt); return; }
                                try {
                                    String raw = client.getInstallReferrer().getInstallReferrer();
                                    String url = ticketUrl(raw);
                                    diagnostic(app, url != null ? "referrer_received" : (raw == null || raw.isEmpty() ? "referrer_empty" : "referrer_unrecognized"));
                                    if (state.deliver(url, prefs.getString(COMPLETED, null))) {
                                        prefs.edit().putString(PENDING, url).commit();
                                        stop();
                                        callback.ready(url);
                                    } else if (url != null && url.equals(prefs.getString(COMPLETED, null))) {
                                        diagnostic(app, "completed");
                                        home(); stop();
                                    } else retry(attempt);
                                } catch (Exception ignored) { diagnostic(app, "referrer_error"); retry(attempt); }
                            });
                        }
                        @Override public void onInstallReferrerServiceDisconnected() { handler.post(() -> retry(attempt)); }
                    });
                } catch (RuntimeException ignored) { retry(attempt); }
            }
        }
        Request request = new Request();
        handler.postDelayed(request::home, 3500);
        request.start();
        return request::stop;
    }

    static boolean complete(Context context, String ticketId) {
        if (ticketId == null || !ticketId.matches("[a-fA-F0-9]{24}")) return false;
        SharedPreferences prefs = preferences(context);
        String pending = prefs.getString(PENDING, null);
        if (pending != null && ticketId.equals(Uri.parse(pending).getQueryParameter("claim"))) {
            prefs.edit().putString(COMPLETED, pending).remove(PENDING).putString("recovery_status", "completed").commit();
            return true;
        }
        return false;
    }
}

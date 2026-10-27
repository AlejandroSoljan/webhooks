// Asisto | Mecan: recuperar el turno después de instalar desde Google Play | 2026-10-27
package ar.com.asisto.mecan;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import java.util.concurrent.atomic.AtomicBoolean;

final class InstallTicketReferrer {
    interface Callback { void ready(String url); }
    private static final String PREFS = "mecan_install_ticket";
    private static final String PENDING = "pending_url";
    private static final String CHECKED = "referrer_checked";

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // Sólo se admiten el identificador y token de MCN. Nunca URLs arbitrarias del referrer.
    static String ticketUrl(String referrer) {
        return InstallTicketLink.fromReferrer(referrer);
    }

    static void resolve(Context context, Callback callback) {
        SharedPreferences prefs = preferences(context);
        String pending = prefs.getString(PENDING, null);
        if (pending != null) { callback.ready(pending); return; }
        if (prefs.getBoolean(CHECKED, false)) { callback.ready(null); return; }
        Handler handler = new Handler(Looper.getMainLooper());
        InstallReferrerClient client = InstallReferrerClient.newBuilder(context.getApplicationContext()).build();
        AtomicBoolean finished = new AtomicBoolean(false);
        class Request {
            void finish(String url, boolean checked) {
                if (!finished.compareAndSet(false, true)) return;
                handler.removeCallbacksAndMessages(null);
                if (checked) {
                    SharedPreferences.Editor editor = prefs.edit().putBoolean(CHECKED, true);
                    if (url != null) editor.putString(PENDING, url);
                    editor.commit(); // Guardar antes de navegar: un reinicio no debe perder el turno.
                }
                try { client.endConnection(); } catch (RuntimeException ignored) {}
                callback.ready(url);
            }
        }
        Request request = new Request();
        handler.postDelayed(() -> request.finish(null, false), 3500);
        try {
            client.startConnection(new InstallReferrerStateListener() {
                @Override public void onInstallReferrerSetupFinished(int responseCode) {
                    if (finished.get()) return;
                    if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        try { request.finish(ticketUrl(client.getInstallReferrer().getInstallReferrer()), true); }
                        catch (Exception ignored) { request.finish(null, false); }
                    } else {
                        request.finish(null, responseCode == InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED);
                    }
                }
                @Override public void onInstallReferrerServiceDisconnected() { request.finish(null, false); }
            });
        } catch (RuntimeException ignored) { request.finish(null, false); }
    }

    static void complete(Context context, String ticketId) {
        if (ticketId == null || !ticketId.matches("[a-fA-F0-9]{24}")) return;
        SharedPreferences prefs = preferences(context);
        String pending = prefs.getString(PENDING, null);
        if (pending != null && ticketId.equals(Uri.parse(pending).getQueryParameter("claim"))) {
            prefs.edit().remove(PENDING).apply();
        }
    }
}

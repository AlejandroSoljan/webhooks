package ar.com.asisto.mecan;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;
import com.google.android.material.snackbar.Snackbar;

/** Play owns download/install. Never clears WebView, preferences, cookies or ticket data. */
final class MecanUpdates {
    private final AppCompatActivity activity;
    private final AppUpdateManager manager;
    private final ActivityResultLauncher<IntentSenderRequest> launcher;
    private final InstallStateUpdatedListener listener;
    private boolean closed, checking, offered;
    private AlertDialog prompt;
    private Snackbar downloaded;

    MecanUpdates(AppCompatActivity activity) {
        this.activity = activity;
        manager = AppUpdateManagerFactory.create(activity);
        launcher = activity.registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), result -> {
                // Cancellation is respected: no automatic retry loop in this opening.
                check();
            });
        listener = state -> {
            if (state.installStatus() == InstallStatus.DOWNLOADED) activity.runOnUiThread(this::ready);
        };
        manager.registerListener(listener);
    }

    private boolean alive() {
        return !closed && !activity.isFinishing() && !activity.isDestroyed();
    }

    void check() {
        if (!alive() || checking) return;
        checking = true;
        manager.getAppUpdateInfo().addOnSuccessListener(info -> {
            checking = false;
            if (!alive()) return;
            if (info.installStatus() == InstallStatus.DOWNLOADED) { ready(); return; }
            if (offered || info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE
                    || info.installStatus() == InstallStatus.DOWNLOADING
                    || info.installStatus() == InstallStatus.PENDING
                    || info.installStatus() == InstallStatus.INSTALLING) return;
            offered = true;
            prompt = new AlertDialog.Builder(activity)
                .setTitle("Hay una actualización de Mecan")
                .setMessage("Podés actualizar desde Google Play sin desinstalar. Tu turno y tus datos guardados se conservan. La descarga puede continuar mientras usás Mecan.")
                .setNegativeButton("Ahora no", null)
                .setPositiveButton("Actualizar", (dialog, which) -> {
                    if (!alive()) return;
                    if (info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)) {
                        try {
                            boolean started = manager.startUpdateFlowForResult(info, launcher,
                                AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build());
                            if (!started) store();
                        } catch (RuntimeException error) { store(); }
                    } else store();
                }).show();
        }).addOnFailureListener(error -> {
            // Offline, debug APK or Play unavailable must never block the active ticket.
            checking = false;
        });
    }

    private void ready() {
        if (!alive() || (downloaded != null && downloaded.isShown())) return;
        downloaded = Snackbar.make(activity.findViewById(R.id.appRoot),
            "Actualización lista. Tu turno y tus datos se conservan.", Snackbar.LENGTH_INDEFINITE)
            .setAction("Instalar", view -> {
                if (!alive()) return;
                manager.completeUpdate().addOnFailureListener(error -> {
                    if (alive()) {
                        downloaded = null;
                        Snackbar.make(activity.findViewById(R.id.appRoot),
                            "No se pudo instalar. Intentá de nuevo al volver a abrir Mecan.", Snackbar.LENGTH_LONG).show();
                    }
                });
            });
        downloaded.show();
    }

    private void store() {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=" + activity.getPackageName())));
        } catch (android.content.ActivityNotFoundException error) {
            Snackbar.make(activity.findViewById(R.id.appRoot),
                "Abrí Google Play y buscá Mecan para actualizar.", Snackbar.LENGTH_LONG).show();
        }
    }

    void close() {
        closed = true;
        manager.unregisterListener(listener);
        if (prompt != null) prompt.dismiss();
        if (downloaded != null) downloaded.dismiss();
    }
}

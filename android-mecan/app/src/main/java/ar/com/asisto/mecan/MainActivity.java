package ar.com.asisto.mecan;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.appcompat.app.AlertDialog;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.io.File;

public class MainActivity extends AppCompatActivity {
    private static final String HOME_URL = "https://asistobot.com.ar/customer-app/MCN";
    private String pushToken = "";
    private WebView webView;
    private ProgressBar progress;
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> fileCallback;
    private Uri capturedPhotoUri;
    private int launchGeneration = 0;

    private final ActivityResultLauncher<String> cameraPermission =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (pendingWebPermission != null) {
                if (granted) pendingWebPermission.grant(pendingWebPermission.getResources());
                else pendingWebPermission.deny();
                pendingWebPermission = null;
            }
        });

    private final ActivityResultLauncher<String> notificationPermission =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> { });

    private final ActivityResultLauncher<Intent> filePicker =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback == null) return;
            Uri[] selected = null;
            if (result.getResultCode() == RESULT_OK && capturedPhotoUri != null) {
                selected = new Uri[]{capturedPhotoUri};
            } else if (result.getResultCode() == RESULT_OK) {
                selected = WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData());
            }
            fileCallback.onReceiveValue(selected);
            fileCallback = null;
            capturedPhotoUri = null;
        });

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.appRoot), (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        webView = findViewById(R.id.webView);
        progress = findViewById(R.id.progress);
        configureWebView();
        requestNotificationPermission();
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            pushToken = token == null ? "" : token;
            injectPushToken();
        });
        loadInitialUrl(getIntent());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack(); else finish();
            }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadInitialUrl(intent);
    }

    private void loadInitialUrl(Intent intent) {
        final int generation = ++launchGeneration;
        String directUrl = urlFromIntent(intent);
        if (!HOME_URL.equals(directUrl)) {
            webView.loadUrl(directUrl);
            return;
        }
        InstallTicketReferrer.resolve(this, url -> runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed() && generation == launchGeneration) {
                webView.loadUrl(url == null ? HOME_URL : url);
            }
        }));
    }

    private void showPrivacy() {
        String installId = PushRegistration.installId(this);
        new AlertDialog.Builder(this)
            .setTitle("Privacidad y mis datos")
            .setMessage("Responsable: Mecan S.A.\nProveedor: Asisto\n\nTu identificador de instalación:\n" + installId +
                "\n\nPodés solicitar la eliminación de tus datos a info@managersistemas.com. El correo no se envía automáticamente.")
            .setPositiveButton("Ver política", (dialog, which) -> openExternal(new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://asistobot.com.ar/privacy/mecan"))))
            .setNeutralButton("Solicitar eliminación", (dialog, which) -> {
                String body = "Solicito la eliminación de mis datos de la app Mecan.\nIdentificador de instalación: " + installId;
                Uri mail = Uri.parse("mailto:info@managersistemas.com?subject=" + Uri.encode("Eliminación de datos de Mecan") + "&body=" + Uri.encode(body));
                openExternal(new Intent(Intent.ACTION_SENDTO, mail));
            })
            .setNegativeButton("Cerrar", null).show();
    }

    private void openExternal(Intent intent) {
        try { startActivity(intent); }
        catch (android.content.ActivityNotFoundException error) {
            new AlertDialog.Builder(this).setMessage("No hay una aplicación compatible. Contactanos en info@managersistemas.com indicando tu identificador: " + PushRegistration.installId(this))
                .setPositiveButton("Cerrar", null).show();
        }
    }

    private String urlFromIntent(Intent intent) {
        String candidate = intent == null ? null : intent.getStringExtra("url");
        Uri incoming = intent == null ? null : intent.getData();
        if (incoming != null && "https".equalsIgnoreCase(incoming.getScheme()) &&
            "asistobot.com.ar".equalsIgnoreCase(incoming.getHost()) &&
            incoming.getPath() != null && incoming.getPath().startsWith("/customer-app/MCN")) {
            return incoming.buildUpon().authority("asistobot.com.ar").build().toString();
        }
        if (incoming != null && "asisto".equalsIgnoreCase(incoming.getScheme()) && "turno".equalsIgnoreCase(incoming.getHost())) {
            candidate = incoming.getQueryParameter("url");
            if (candidate != null) {
                Uri ticket = Uri.parse(candidate);
                String host = ticket.getHost();
                if ("https".equalsIgnoreCase(ticket.getScheme()) &&
                    ("asistobot.com.ar".equalsIgnoreCase(host) || "www.asistobot.com.ar".equalsIgnoreCase(host)) &&
                    ticket.getPath() != null && ticket.getPath().startsWith("/customer-app/")) {
                    return ticket.buildUpon().authority("asistobot.com.ar").build().toString();
                }
            }
            return HOME_URL;
        }
        if (candidate != null) {
            Uri uri = Uri.parse(candidate);
            String host = uri.getHost();
            if ("https".equalsIgnoreCase(uri.getScheme()) &&
                ("asistobot.com.ar".equalsIgnoreCase(host) || "www.asistobot.com.ar".equalsIgnoreCase(host)) &&
                uri.getPath() != null && uri.getPath().startsWith("/customer-app/MCN")) {
                return uri.buildUpon().authority("asistobot.com.ar").build().toString();
            }
        }
        return HOME_URL;
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
        }
    }

    @SuppressLint("SetJavaScriptEnabled") private void configureWebView() {
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new NativeBridge(), "AsistoNative");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    Uri origin = request.getOrigin();
                    if (!"https".equalsIgnoreCase(origin.getScheme()) ||
                        !("asistobot.com.ar".equalsIgnoreCase(origin.getHost()) || "www.asistobot.com.ar".equalsIgnoreCase(origin.getHost()))) {
                        request.deny();
                        return;
                    }
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        pendingWebPermission = request;
                        cameraPermission.launch(Manifest.permission.CAMERA);
                    }
                });
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    File photo = File.createTempFile("asisto-product-", ".jpg", getCacheDir());
                    capturedPhotoUri = FileProvider.getUriForFile(
                        MainActivity.this, getPackageName() + ".files", photo);
                    Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                        .putExtra(MediaStore.EXTRA_OUTPUT, capturedPhotoUri)
                        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    if (camera.resolveActivity(getPackageManager()) == null) throw new IllegalStateException("camera unavailable");
                    filePicker.launch(camera);
                    return true;
                } catch (Exception ex) {
                    fileCallback = null;
                    capturedPhotoUri = null;
                    return false;
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                injectPushToken();
                PushRegistration.ensure(MainActivity.this);
                if (pushToken != null && !pushToken.isEmpty()) PushRegistration.register(MainActivity.this, pushToken);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) &&
                    ("asistobot.com.ar".equalsIgnoreCase(uri.getHost()) || "www.asistobot.com.ar".equalsIgnoreCase(uri.getHost()))) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });
    }

    private final class NativeBridge {
        @JavascriptInterface public void completeInstallTicket(String ticketId) {
            InstallTicketReferrer.complete(MainActivity.this, ticketId);
        }

        @JavascriptInterface public void showPrivacy() {
            runOnUiThread(() -> MainActivity.this.showPrivacy());
        }

        @JavascriptInterface public String getInstallId() {
            return PushRegistration.installId(MainActivity.this);
        }

        @JavascriptInterface public void adoptInstallId(String installId) {
            PushRegistration.adoptInstallId(MainActivity.this, installId);
        }
    }

    private void injectPushToken() {
        if (webView == null || pushToken == null || pushToken.isEmpty()) return;
        String quoted = JSONObject.quote(pushToken);
        webView.post(() -> webView.evaluateJavascript(
            "window.AsistoNativePushToken=" + quoted + ";window.dispatchEvent(new CustomEvent('asisto-push-token',{detail:" + quoted + "}));", null));
    }
}

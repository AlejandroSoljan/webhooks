package ar.com.asistobot.scanner;

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

import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.io.File;

public class MainActivity extends AppCompatActivity {
    private static final String HOME_URL = "https://asistobot.com.ar/customer-app/DEMO_FERRETERIA";
    private String pushToken = "";
    private WebView webView;
    private ProgressBar progress;
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> fileCallback;
    private Uri capturedPhotoUri;

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
        webView = findViewById(R.id.webView);
        progress = findViewById(R.id.progress);
        configureWebView();
        requestNotificationPermission();
        FirebaseMessaging.getInstance().subscribeToTopic("demo_ferreteria");
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            pushToken = token == null ? "" : token;
            injectPushToken();
        });
        webView.loadUrl(urlFromIntent(getIntent()));

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack(); else finish();
            }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        webView.loadUrl(urlFromIntent(intent));
    }

    private String urlFromIntent(Intent intent) {
        String candidate = intent == null ? null : intent.getStringExtra("url");
        if (candidate != null) {
            Uri uri = Uri.parse(candidate);
            if ("https".equalsIgnoreCase(uri.getScheme()) && "asistobot.com.ar".equalsIgnoreCase(uri.getHost())) return candidate;
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
                    if (!"https".equalsIgnoreCase(origin.getScheme()) || !"asistobot.com.ar".equalsIgnoreCase(origin.getHost())) {
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
                if ("https".equalsIgnoreCase(uri.getScheme()) && "asistobot.com.ar".equalsIgnoreCase(uri.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });
    }

    private final class NativeBridge {
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

# Conservar únicamente los nombres llamados por JavaScript en WebView.
# R8 puede optimizar/ofuscar el resto de la app y las bibliotecas.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

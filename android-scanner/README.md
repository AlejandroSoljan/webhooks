# Asisto Escáner Android

Aplicación Android instalable manualmente para leer QR, EAN, UPC, Code 128, Code 39, ITF y Codabar. El dominio inicial es `DEMO_FERRETERIA` y puede cambiarse desde la pantalla principal.

La aplicación no contiene claves privadas. Después de leer el código abre dentro de la app la ficha pública `https://asistobot.com.ar/qr/{dominio}/{codigo}`.

## Compilar

```text
gradlew.bat assembleDebug
```

El APK queda en `app/build/outputs/apk/debug/app-debug.apk`.

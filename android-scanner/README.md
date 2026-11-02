# Asisto Escáner Android

Versión 1.1.8 (código 10): registra identidad estable para evitar duplicados de notificaciones y usa el dominio de la página customer-app abierta. Se distribuye manualmente; no implica actualización automática de instalaciones existentes. No cambia installId ni datos del turno.

Aplicación Android instalable manualmente para leer QR, EAN, UPC, Code 128, Code 39, ITF y Codabar. El dominio inicial es `DEMO_FERRETERIA` y puede cambiarse desde la pantalla principal.

La aplicación no contiene claves privadas. Después de leer el código abre dentro de la app la ficha pública `https://asistobot.com.ar/qr/{dominio}/{codigo}`.

## Compilar

```text
gradlew.bat assembleDebug
```

El APK queda en `app/build/outputs/apk/debug/app-debug.apk`.

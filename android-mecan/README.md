# Mecan Android

## Versión 1.0.1 (2) — 27/10/2026

Recupera el turno enviado desde la web mediante Play Install Referrer 2.2. El vínculo permanece pendiente hasta confirmar su asociación; no acepta URLs arbitrarias ni reemplaza un enlace explícito de apertura. Ver `../docs/MECAN_INSTALACION_TURNO.md` para despliegue, asociación de firma Play y activación coordinada del modal. No activar la invitación mientras Google Play sólo distribuya la versión 1.0.0 sin recuperación automática.

Aplicación oficial de Mecan para Android. Presenta la aplicación web del dominio `MCN` dentro de un WebView seguro y registra el dispositivo para recibir notificaciones de turnos mediante Firebase Cloud Messaging.

- URL principal: `https://asistobot.com.ar/customer-app/MCN`
- Identificador Android: `ar.com.asisto.mecan`
- Nombre público: `Mecan`
- Desarrollador previsto en Google Play: `Asisto`

Firebase: app Android registrada en `asisto-34dbd`, con ID `1:940496657556:android:d31914592e1aa58422e881`. La configuración de `app/google-services.json` corresponde al cliente Mecan del archivo oficial descargado el 16/10/2026. La recepción de notificaciones todavía requiere una prueba en un dispositivo Android.

## Compilar

Abrir la carpeta `android-mecan` en Android Studio (JDK 17 o superior) y ejecutar la variante `debug`, o usar una instalación local de Gradle 8.9:

```text
gradle assembleDebug
```

El APK de desarrollo queda en `app/build/outputs/apk/debug/app-debug.apk`.

## Release para Google Play

Versión 1.0.2 (3): enlaces MCN en asisto.com.ar y asistobot.com.ar, con y sin www, conservando turno y origen interno. Release usa R8 y shrinkResources; los métodos JavascriptInterface se conservan mediante reglas específicas. El mapa queda en `app/build/outputs/mapping/release/mapping.txt` y se incorpora al AAB. Ejecutar las pruebas JVM de `MecanLinksTest` e `InstallTicketLinkTest` antes de publicar. La comprobación física requiere la firma de Play y enlaces compatibles habilitados en Android; una compilación correcta no acredita ese recorrido.

Ejecutar `./build-release.ps1` en PowerShell. Usa JDK 17, Gradle 8.11.1, Android API 36 y la clave de carga exclusiva de Mecan, guardada fuera del repositorio en `C:\Asisto\android-signing\mecan`.

- AAB: `app/build/outputs/bundle/release/app-release.aab`.
- APK release para prueba: `app/build/outputs/apk/release/app-release.apk`.
- Borrador de ficha y pendientes: `PLAY_STORE.txt`.

La contraseña cifrada está vinculada al usuario y equipo Windows; respaldar clave y contraseña de forma independiente antes de publicar. El APK debug instalado usa otra firma: no puede actualizarse directamente con el release. No desinstalarlo sin considerar que se borrarán sus datos locales.

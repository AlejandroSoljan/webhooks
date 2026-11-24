# Mecan iOS

Proyecto de Mecan para iPhone con Firebase Messaging y el identificador `ar.com.asisto.mecan`.

La compilación de simulador se ejecuta en GitHub Actions al actualizar la rama `codex/mecan-ios-build`.

## TestFlight

El workflow Mecan TestFlight se ejecuta manualmente cuando está disponible en la rama por defecto, o al subir una etiqueta `mecan-testflight-*` sobre el commit a distribuir. Requiere el certificado Apple Distribution con su clave privada y un perfil App Store Connect de Mecan con APNs de producción. Configurar el P12 y el perfil como secretos `MECAN_IOS_CERTIFICATE_BASE64` y `MECAN_IOS_PROFILE_BASE64`, y la contraseña como `MECAN_IOS_CERTIFICATE_PASSWORD`.

La carga requiere una clave de App Store Connect con permisos de carga. Configurar `MECAN_ASC_KEY_BASE64`, `MECAN_ASC_KEY_ID` y `MECAN_ASC_ISSUER_ID`. Usar una clave de App Store Connect distinta de la clave APNs configurada en Firebase.

El workflow verifica el entitlement de producción en el archivo firmado antes de cargarlo. Confirmar el procesamiento en TestFlight desde App Store Connect, app 6837477271.

Pendientes de la beta: vincular los tokens FCM al turnero, implementar la apertura desde avisos y verificar cámara, cuenta y notificaciones en un iPhone.

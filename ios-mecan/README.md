# Mecan iOS

Base inicial del proyecto iOS, con identificador ar.com.asisto.mecan y Firebase Messaging. Requiere macOS con Xcode y XcodeGen.

En macOS, desde esta carpeta, ejecutar:
 
    xcodegen generate
    xcodebuild -project Mecan.xcodeproj -scheme Mecan -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

Para TestFlight, configurar la firma del equipo 6TJ9WJ9766 en Xcode, verificar el entitlement APNs de producción en el archivo firmado y archivar para App Store Connect (Apple ID 6837477271).

Pendientes antes de distribuir: configurar APNs en Firebase, vincular los tokens FCM de iOS al turnero, implementar apertura del turno desde el aviso, agregar el icono oficial y verificar cámara, cuenta y avisos en un iPhone.

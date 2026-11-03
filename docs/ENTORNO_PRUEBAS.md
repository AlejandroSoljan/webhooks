# Entorno aislado de pruebas

Preparación: 2026-11-03. No es una copia de datos productivos ni un entorno para envíos reales.

## Estado verificado

Instalado y habilitado en AWS. /healthz responde correctamente. La prueba dentro del namespace verificó conexión a asisto_staging y bloqueo de MongoDB del host (27017) e Internet. Producción y turnero mantuvieron respuestas saludables. El primer arranque puede tardar aproximadamente un minuto por los límites de CPU; no interpretarlo como fallo tras sólo 30 segundos.

Administrador sintético: staging-admin, dominio DEMO_DEV. Contraseña aleatoria en /etc/asisto-staging-access.json, acceso sólo root. No enviarla en Git ni reutilizarla para colaboradores; crear cuentas individuales cuando se asignen. No se copiaron colecciones de producción. La aplicación puede inicializar índices y utilizar catálogos de demostración incluidos en el código.

## Diseño

- Código separado: /opt/asisto-staging/releases/79852e6; current apunta a esa instantánea reproducible del repositorio.
- No presupone equivalencia con todos los parches de producción. Antes de iniciar una funcionalidad, reconciliar la base acordada.
- Usuario Linux: asisto-staging. No lee /etc/asisto, /opt/asisto ni /var/lib/asisto desde sus servicios.
- MongoDB independiente: base asisto_staging, puerto 27018, datos en /var/lib/asisto-staging/mongo.
- MongoDB y aplicación comparten una red privada de systemd, sin acceso al MongoDB del host ni a Internet. Sólo se permite comunicación dentro de esa red.
- Aplicación accesible mediante socket Unix /run/asisto-staging/web.sock; nginx lo publica únicamente en 127.0.0.1:3101 del host.
- Cookie y secreto de sesión propios en /etc/asisto-staging.env. No reutilizar configuración productiva.
- Límites: aplicación 512 MB, MongoDB 512 MB, 25% de una CPU por servicio. Ajustar sólo después de medir.

## Acceso individual

Requiere SSH autorizado y Tailscale activo. Desde la PC autorizada:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:33101:127.0.0.1:3101 asisto-aws
```

Abrir http://127.0.0.1:33101. En esta PC el alias puede incluir otro forward; si hay conflicto, preparar un alias propio sólo para pruebas. No compartir la clave privada de otra persona. Cada colaborador necesita su identidad SSH y cuenta de prueba propias; no se ha dado acceso a una persona todavía no identificada.

## Operación

Servicios: asisto-staging y asisto-staging-mongo. No confundir con asisto-production, asisto-turnero o mongod.

Verificar /healthz en 127.0.0.1:3101, conexión a asisto_staging y aislamiento de red. Para reiniciar MongoDB de pruebas, detener primero la aplicación y arrancarla después: ambos servicios comparten el namespace y deben reencontrarse en el nuevo namespace.

No activar integraciones con claves reales. Las conexiones externas fallarán deliberadamente. Usar simuladores locales o definir posteriormente un entorno específico de integración con cuentas de prueba.

El instalador deploy/staging/install.sh es de instalación inicial, rechaza una carpeta existente y no debe usarse como actualizador. Para futuras entregas: preparar otro release, instalar dependencias separadas, ejecutar pruebas y cambiar exclusivamente staging/current con rollback. No conectar staging al auto-deploy de producción.

## Protección de main

Configuración verificada el 2026-11-03: una aprobación por PR, invalidación de aprobaciones al cambiar código, revisión CI build (24.x) obligatoria y rama actualizada, conversaciones resueltas, sin force-push ni borrado. Los administradores conservan excepción de recuperación; usarla sólo de forma explícita. No impide que un administrador cambie estas reglas.

El repositorio es público en esta fecha. Esta preparación no cambia su visibilidad. Las credenciales y datos privados nunca deben incorporarse a Git. Queda pendiente acordar si se cambia a privado.

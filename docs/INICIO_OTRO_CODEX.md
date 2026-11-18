# Abrir Asisto desde otro Codex

Copiá este bloque en el otro Codex. Descarga el repositorio existente completo y la documentación de incorporación que está en la rama `codex/colaboracion-asisto`.

```text
Prepará este equipo para trabajar en Asisto, en su repositorio existente https://github.com/AlejandroSoljan/webhooks.git. La funcionalidad nueva será Manager Go. Su extensión ya está funcionando y su responsable la incorporará después.

Si no existe un checkout local, cloná el repositorio en una carpeta webhooks. Si ya existe, verificá el remoto y los cambios locales antes de actuar. Ejecutá git fetch origin. La guía de incorporación y las reglas actualizadas están publicadas en origin/codex/colaboracion-asisto, pendiente de integrar a main. Para este arranque creá una rama nueva codex/manager-go desde origin/codex/colaboracion-asisto. Si la rama ya existe o hay cambios locales, preservalos y revisá cómo incorporar esa base. Así obtenés todo el código versionado de main junto con las instrucciones nuevas.

Con la carpeta de Asisto como proyecto de trabajo, leé primero AGENTS.md y docs/INICIO_OTRO_CODEX.md. Continuá con docs/MANUAL_OPERADOR_CODEX_MANAGER_GO.md, docs/MANUAL_TECNICO_ASISTO.md y docs/MANAGER_GO_APIS_ASISTO.md. Aplicá esas reglas a los cambios. Verificá Node.js 24 e instalá dependencias con npm ci. Informá la rama, commit descargado y resultado de la instalación. Identificá las rutas, permisos, habilitación por dominio y medición de operaciones que necesita Manager Go. El endpoint de Manager Go está propuesto y pendiente de implementación.

Trabajamos en este mismo repositorio de Asisto. Manager Go se incorpora como funcionalidad propia, informada por las APIs de dominio y medida en Control de Tokens. La configuración de prueba usa datos sintéticos y una base separada. Las credenciales y accesos a AWS son específicos de cada entorno y se coordinan con el mantenedor. Si falta un dato, avanzá con el análisis del código y señalá exactamente qué acceso o dato hace falta para la siguiente prueba.
```

## Datos productivos y alcance del checkout

La aplicación publicada usa MongoDB `Cluster0` en AWS Lightsail. La base y el host deben verificarse por SSH antes de informar datos productivos o escribir cambios. Las copias locales y Atlas pueden contener datos históricos y no sustituyen esa verificación. MongoDB se mantiene en loopback y se accede por un túnel autorizado.

El checkout trae el código, reglas, documentación y pruebas que están versionados. Las credenciales, las sesiones, las bases de clientes y los cambios locales que todavía no se publicaron requieren coordinación con el mantenedor. Antes de un despliegue, compará el release activo con el commit que se propone publicar y seguí AGENTS.md.

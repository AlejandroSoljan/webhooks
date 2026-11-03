# Incorporación de desarrolladores

Preparado el 2026-11-02. Leer primero AGENTS.md, este documento, ARQUITECTURA.md, ESTANDARES_DESARROLLO.md y el capítulo funcional del MANUAL_TECNICO_ASISTO.md.

## Preparación de otra PC

Repositorio: https://github.com/AlejandroSoljan/webhooks. Cada persona debe usar su cuenta y acceso individual.

1. Acordar funcionalidad, revisor y commit base con Alejandro.
2. Clonar el repositorio y crear una rama `codex/<funcionalidad>` desde ese commit.
3. Instalar Node 24.x (requisito de package.json) y ejecutar `npm ci` usando el lockfile.
4. Copiar `.env.example` a `.env`, con MongoDB exclusivo de desarrollo y datos sintéticos.
5. Revisar los inicializadores del módulo antes de arrancar. La plantilla mínima no es un sandbox automático ni configura todas las integraciones.

No asumir que main equivale a producción: existen releases incrementales con diferencias entre AWS y Mecan. El responsable debe reconciliar los cambios pendientes y entregar una base verificada. La rama codex/notifications-device-dedup contiene esta preparación, pero no constituye automáticamente la base aprobada para cualquier funcionalidad.

## Ejecución y pruebas

`npm start` ejecuta endpoint.js; `npm run dev` utiliza nodemon. Antes de ejecutarlos, verificar que no haya credenciales reales ni inicializadores que contacten servicios productivos. Preparar usuario de prueba y datos sintéticos con el responsable; esta guía no ofrece un bootstrap integral validado.

- Sintaxis: `node --check archivo_modificado.js`.
- Prueba focalizada real de ejemplo: `node --test tests/product_insights.test.js`.
- Suite existente: `npm test`; revisar los requisitos de las pruebas y no apuntarlas a producción.
- mongodb-memory-server puede descargar un binario en su primera ejecución; requiere red y tiempo.
- Verificar permisos, dominio ajeno, interfaz, errores y fechas de Argentina según el cambio.

No agregar claves de producción para resolver errores de instalación. Consultar variables en docs/manual-tecnico/entorno.md y el capítulo del módulo. La configuración real se entrega por un canal seguro separado de Git.

## Entrega

Subir la rama y presentar un pull request con comportamiento, pruebas y límites. Actualizar documentación funcional. El responsable de integración asigna la versión global; no desplegar directamente desde cada rama.

## Pendientes operativos

- [ ] Usuario GitHub e invitación del colaborador.
- [ ] Funcionalidad, revisor y commit base reconciliado.
- [ ] MongoDB, datos sintéticos y usuario de prueba.
- [ ] Entorno de pruebas y cuentas externas de prueba.
- [x] Protección de main y revisiones verificadas en GitHub (2026-11-03; excepción de administrador documentada).
- [ ] Exclusión mutua del despliegue real, incluido auto-deploy del servidor.

La preparación posterior del servidor de pruebas se documenta en [Entorno de pruebas](ENTORNO_PRUEBAS.md). Los accesos individuales y Codespaces no quedan creados por esta documentación.

## Mensaje para el otro Codex

> Leé AGENTS.md y las guías de incorporación, arquitectura y estándares antes de modificar. Confirmá el commit base asignado y trabajá en una rama propia, sólo en la funcionalidad acordada y con datos de prueba. Documentá los cambios y validaciones. Entregá un pull request sin desplegar producción.

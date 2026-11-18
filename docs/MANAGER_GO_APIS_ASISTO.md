# APIs de Asisto para integrar funcionalidades | Manager Go

La extensión de Manager Go ya se conecta a Manager. Para agregar Asisto al flujo, la extensión enviará una operación completada y Asisto la asociará con el dominio habilitado. Las APIs administrativas sirven para configurar y verificar la integración desde Asisto.

| API existente | Para qué sirve | Acceso |
| --- | --- | --- |
| `GET /api/ext/domain-status?dominio=DEMO` | Consulta externa de servicios por dominio. Devuelve `domains[]` con `tenantId`, `servicios` y `sessions`. Manager Go debe agregarse a `servicios` del dominio habilitado, incluso sin sesiones de WhatsApp. | Clave de servicio actual, administrada del lado servidor. |
| `GET /api/tenant-config?tenantId=DEMO` y `POST /api/tenant-config` | Consulta y edición de configuración por dominio. Punto de administración para incorporar la habilitación de Manager Go. | Sesión administrativa y permiso de configuración. |
| `GET /api/monetization/summary?tenantId=DEMO&from=AAAA-MM-DD&to=AAAA-MM-DD` | Resumen de operaciones medidas por concepto y período. Control de Tokens lo usa para mostrar Consumo por funcionalidad y el detalle. Agregar aquí Manager Go como concepto de operaciones. | Sesión Asisto. La vista superadmin puede elegir dominio. |
| `GET /api/monetization/config?tenantId=DEMO` y `PUT /api/monetization/config` | Consulta y guarda reglas de monetización por dominio. Permite administrar la medición y, cuando se decida, el precio. | Superadmin. |
| `GET /api/token-control/summary` y `GET /api/token-control/timeline` | Totales y evolución del Control de Tokens. Admiten `from`, `to`, `types` y `channels`. La vista superadmin puede elegir `tenantId`. Las operaciones de Manager Go se miden como operaciones. Si alguna función usa IA, sus tokens siguen el registro habitual de IA. | Sesión Asisto y permiso de Control de Tokens. |

## API nueva para la extensión

Ruta propuesta, pendiente de implementar: `POST /api/ext/manager-go/operations`. La extensión la llamaría con una credencial exclusiva de Manager Go asociada al dominio. El servidor valida la habilitación, registra una sola vez por dominio e identificador de operación y contabiliza esa operación en el reporte. La extensión usa esta credencial de alcance limitado. Las claves globales y las sesiones administrativas quedan del lado de Asisto.

Campos mínimos propuestos: `operationId` estable, `operationType` y `occurredAt`. El contenido de la operación se define con un ejemplo anonimizado de Manager. En la primera etapa, medir sin aplicar cargos. Verificar que un reintento deje un registro y una sola operación en el reporte.

Referencias: [manual técnico](MANUAL_TECNICO_ASISTO.md), [inventario de rutas](manual-tecnico/rutas.md) y [prompt de integración](MANAGER_GO_ARRANQUE.md).

## Usuarios y configuración de dominios

- Para trabajar en el código y probar localmente, el desarrollador puede usar una cuenta creada en su base local. Para verificar el resultado en el panel compartido de pruebas, necesitás una cuenta personal de Asisto en ese entorno. La extensión usa su credencial de instalación de Manager Go, separada del usuario del panel.
- En staging, un superadmin entra a **Configuración del negocio → Dominio → Nuevo dominio**. Elegí un dominio de pruebas existente o creá uno exclusivo, por ejemplo `MGO_DEMO` si está disponible. Guardá su identificador y nombre comercial. Si el dominio ya existe, editá su configuración conservando los demás campos. Usá la pantalla para editarlo o conservá el documento completo al usar `POST /api/tenant-config`, que guarda el conjunto de campos del dominio.
- Desde **Administración → Usuarios**, el mantenedor puede crear una cuenta personal asociada a ese dominio. Para consultar resultados, asigná rol `user` y la pantalla **Control de Tokens**. Si también va a modificar configuración, asigná rol `admin` del dominio de pruebas y el acceso **Dominio Config**. La administración de tarifas queda a cargo del superadmin.
- Cuando se implemente Manager Go, habilitalo en ese dominio, emití su credencial de instalación y configurá en la extensión la URL del entorno de pruebas. El campo de habilitación y la emisión de la credencial forman parte de la integración pendiente. Guardá la credencial fuera del repositorio. Para una instalación que sólo envía operaciones de Manager Go alcanza su credencial de integración.
- Validá el alta en `domains[].servicios` de la API de consulta por dominio. Enviá una operación y repetí el mismo identificador. Confirmá una operación registrada en **Control de Tokens** para el período y el dominio elegidos. Si un cliente usa dominios secundarios, probá el dominio que emitió el evento y su visibilidad en el reporte agrupado.

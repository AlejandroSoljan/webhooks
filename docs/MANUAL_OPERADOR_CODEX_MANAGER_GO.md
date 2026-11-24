# Manual de incorporación a Asisto para Manager Go

Este manual es para la persona que ya desarrolla **Manager Go** y va a integrar la extensión con **Asisto** desde su propio Codex. La extensión ya funciona con Manager. El trabajo nuevo consiste en enviar a Asisto las operaciones acordadas, habilitar Manager Go por dominio y mostrar su actividad en Control de Tokens.

## 1. Cómo se organiza Asisto

Asisto ofrece mensajería, atención con IA, pedidos, catálogos, turnero y otras integraciones. El backend usa Node.js y MongoDB. Un **dominio** o `tenant` identifica al cliente dentro de Asisto y determina qué configuración, operaciones y permisos le corresponden. Es un identificador de negocio, no una dirección web. Un cliente también puede tener dominios secundarios. Cada operación conserva el dominio que la originó, aunque el reporte consolide consumos bajo un titular.

| Pantalla | Uso durante la integración |
| --- | --- |
| **Configuración del negocio → Dominio** | Crear o seleccionar el dominio de pruebas y, una vez implementado, habilitar Manager Go. |
| **Administración → Usuarios** | Asociar una cuenta del panel al dominio y elegir qué pantallas puede usar. |
| **Consumos y facturación → Control de Tokens** | Revisar las operaciones de Manager Go por dominio y rango de fechas. |
| **Consumos y facturación → Monetización** | Configurar cómo se mide el concepto. La tarifa requiere una decisión comercial. |

Para explorar otros módulos, consultá el [manual técnico de Asisto](MANUAL_TECNICO_ASISTO.md), en particular *Arquitectura*, *Alta de un cliente*, *Usuarios y permisos* y *Consumos y facturación*.

## 2. Abrir el trabajo en Codex

Abrí el proyecto existente de Manager Go y pegá el bloque del [prompt de integración](MANAGER_GO_ARRANQUE.md). Pedile que conserve esa carpeta y trabaje el backend de Asisto en un checkout aparte. La [guía de colaboración](COLABORACION.md) contiene los comandos de clonación, instalación y pruebas. Usá **Node.js 24** para Asisto.

El repositorio de Asisto es público y se puede clonar sin pedir acceso. Trabajá desde `origin/main` en `codex/manager-go`. Si ya existe una rama de trabajo, revisá su contenido antes de reutilizarla. Los cambios de la extensión van en su propio repositorio. Para subir una rama al repositorio compartido hace falta permiso de escritura. La revisión de Asisto se hace mediante un PR hacia `main`, con una aprobación y el chequeo `build (24.x)`. La puesta en producción se coordina después de validar en pruebas.

## 3. Qué cuenta necesita cada parte

| Quién o qué | Acceso |
| --- | --- |
| **Desarrollador en su PC** | Puede empezar con Git, Codex y una base de pruebas local. Usá una cuenta local si necesitás entrar al panel. |
| **Persona que verifica el resultado en staging** | Cuenta personal de Asisto en ese entorno, rol `user`, dominio de pruebas y permiso **Control de Tokens**. El entorno compartido requiere un acceso remoto coordinado con el mantenedor. |
| **Persona que modifica configuración del dominio** | Rol `admin` del dominio de pruebas con **Dominio Config**. Un superadmin se ocupa del alta inicial y de la monetización. |
| **Extensión instalada** | Credencial exclusiva de Manager Go vinculada a un dominio. La emisión de esta credencial forma parte de la implementación. |

Para crear el dominio, el superadmin abre **Configuración del negocio → Dominio → Nuevo dominio**, registra un identificador libre como `MGO_DEMO` y guarda el nombre. Puede usar un dominio de pruebas existente si ya está asignado al proyecto. Después, si hace falta acceso al panel, crea la cuenta en **Administración → Usuarios** con ese dominio. Cada entorno usa su propia configuración y credenciales. Los datos de prueba deben ser sintéticos.

## 4. Qué hay que implementar

1. **Acordar la primera operación.** Ubicá dónde la extensión existente detecta que Manager completó la operación. Pedí un ejemplo anonimizado de los campos, el identificador que permanece estable al reintentar y el momento de la operación. Esto define el contrato de recepción.
2. **Habilitar Manager Go por dominio.** Agregá la opción a la configuración del dominio y publicala en `domains[].servicios` de `GET /api/ext/domain-status`. Debe aparecer para dominios habilitados aunque no tengan sesiones de WhatsApp. La habilitación inicial queda apagada.
3. **Conectar la extensión.** El endpoint propuesto es `POST /api/ext/manager-go/operations`. El servidor obtiene el dominio de la autorización, verifica la habilitación y valida los datos. Guardá una sola operación por dominio e identificador, incluso con reintentos. Establecé cómo se recupera el conteo si el guardado termina y la medición falla.
4. **Medir la actividad.** Usá el catálogo y motor de monetización existentes para mostrar **Manager Go** como concepto propio por dominio y período. La primera etapa mide sin aplicar un cargo. Las operaciones son la unidad de medición de Manager Go. Los tokens corresponden al consumo real de las funciones que usen IA.

La [referencia de APIs para Manager Go](MANAGER_GO_APIS_ASISTO.md) detalla las rutas existentes, sus permisos y la ruta nueva. En el código, empezá por `endpoint.js` para el estado por dominio, `auth_ui.js` para permisos y configuración, y `monetization_config.js`, `monetization_engine.js` y `token_control_stats.js` para la medición y el panel.

## 5. Cómo saber si la integración funciona

| Prueba | Resultado esperado |
| --- | --- |
| Dominio de pruebas habilitado y sin WhatsApp | La API de dominio devuelve **Manager Go** en `servicios`. |
| Operación completada desde la extensión existente | Queda registrada en el dominio de la credencial y aumenta su conteo en uno. |
| Reintento de la misma operación | Sigue habiendo un registro y una operación medida. |
| Credencial ausente, inválida o de otro dominio | La operación no se registra bajo un dominio ajeno. |
| Dominio deshabilitado o datos inválidos | La operación se rechaza. |
| Dos dominios y dos rangos de fechas | El panel muestra sólo los movimientos que corresponden a cada filtro. |
| Primera etapa sin tarifa | La actividad aparece en el reporte con cargo cero. |

Al entregar, incluí los commits o PR de cada repositorio, la operación elegida, una muestra anonimizada, las instrucciones para habilitarla y el resultado de estas pruebas. Actualizá el manual técnico de Asisto cuando cambien rutas, permisos, configuración o comportamiento. Indicá qué se verificó con la extensión y qué sigue pendiente de validar con Manager real.

La habilitación, la credencial de instalación y el endpoint de Manager Go están pendientes de implementación. La primera decisión operativa es elegir la operación de Manager que se va a registrar y obtener su ejemplo anonimizado.

## Desplegar desde la otra PC

Seguí [Acceso al staging AWS](ACCESO_STAGING_MANAGER_GO.md) para autorizar la PC, abrir el panel con túnel SSH y subir un commit de prueba. El ingreso requiere completar la autorización de Tailscale y registrar la clave pública de esa PC.

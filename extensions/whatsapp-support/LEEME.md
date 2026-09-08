<!-- Asisto | Version: 5.00.068 | Fecha: 2026-09-08 -->
# Asisto · Tareas de WhatsApp

1. Descomprimí el ZIP en una carpeta que vayas a conservar.
2. En Chrome, ingresá a `chrome://extensions`, activá **Modo de desarrollador** y pulsá **Cargar descomprimida**. Elegí la carpeta que contiene `manifest.json`.
3. Ingresá a [Asisto](https://asistobot.com.ar/ui/support) con tu usuario, en el mismo perfil de Chrome. Baileys debe seguir ejecutándose en tu PC para sincronizar mensajes nuevos.
4. Abrí o recargá [WhatsApp Web](https://web.whatsapp.com). Junto a los contactos con tareas aparecerá un icono con la cantidad. Al pulsarlo se abre el panel lateral con sus tareas. También podés abrirlo desde el botón de la extensión y elegir el contacto.
5. Revisá y editá el resumen. **Guardar en Asisto** conserva los cambios. **Preparar HubSpot** permite revisar el destino, el estado y la clasificación. **Guardar en HubSpot** crea el ticket; los siguientes guardados de esa misma tarea actualizan el mismo ticket.

La extensión no abre páginas automáticamente. Los iconos se actualizan cada 30 segundos y al desplazarte por la lista. Solo identifica contactos por su identificador visible o por un nombre exacto y único; si hay nombres repetidos, usá el selector del panel. WhatsApp puede cambiar su estructura visual: el selector sigue disponible si un cambio impide colocar el icono.

## Conexión de HubSpot

La conexión se guarda por **tenantId**, cifrada en Asisto. Si ya existe, se reutiliza. Si falta, un administrador puede ingresar el token de la aplicación privada existente desde **Preparar HubSpot**. La extensión no lo guarda ni lo entrega a WhatsApp.

La aplicación privada necesita permisos para consultar las propiedades y los pipelines de tickets, leer y escribir tickets y consultar la información de la cuenta. Para asociar empresa/contacto por sus ID también necesita leer esos objetos y sus asociaciones. Asisto comprueba la conexión con las API antes de guardarla.

Las categorías, tipos de error y vías de contacto conservan los valores del borrador. En la preparación elegí las propiedades y opciones reales de tu portal: las etiquetas se traducen a sus identificadores internos. La selección de propiedades se recuerda por dominio y portal. El estado del ticket se elige dentro de su pipeline.

El nombre de WhatsApp y la empresa quedan incluidos en la descripción del ticket. **No se crean contactos o empresas automáticamente**. Si completás los ID de empresa/contacto, Asisto verifica la asociación antes de crear el ticket. Para cambiar las asociaciones de un ticket ya creado, usá HubSpot.

Si una respuesta de HubSpot se pierde, la tarea queda con envío sin confirmar y no se crea otro ticket al reintentar. Revisá el portal antes de resolver ese estado. Los cambios concurrentes y las tareas con nuevos mensajes pendientes de revisión requieren recargar/revisar el borrador.

## Datos y sesión

La extensión usa la sesión existente de Asisto y respeta el usuario, tenantId y exclusiones. WhatsApp recibe únicamente las etiquetas y cantidades necesarias para los iconos; el resumen se consulta en el panel de la extensión. No se leen almacenes privados de WhatsApp ni se envían mensajes. Los únicos servidores utilizados son Asisto y, desde el servidor de Asisto, HubSpot.

Si pide iniciar sesión, abrí Asisto en el mismo perfil, ingresá y pulsá **Actualizar**. Las políticas del navegador que bloquean cookies de extensiones pueden impedir compartir esa sesión. Esta versión se instala como extensión descomprimida; todavía no está publicada en Chrome Web Store.

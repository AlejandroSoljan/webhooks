# Estadísticas de Ayuda

Acceso superadministrador: /admin/help-stats. Consultas de MANAGER filtradas por fecha, dominio cliente, usuario, ventana, modalidad y resultado. Hasta 366 días por búsqueda, detalle de 50 filas, CSV de página compatible con Excel. Usa help_query_log. Los IDs de videos representan devoluciones, no reproducciones. Los errores anteriores no registrados no se reconstruyen. Fechas de gráficos y filas en Argentina.

Menú principal: Atención al cliente → Estadísticas de Ayuda, visible exclusivamente para superadministradores.

El acceso /ui/help_stats conserva el menú principal de Asisto. /admin/help-stats redirige allí; con embed=1 entrega el contenido interno.

Permiso help_stats disponible en Acceso a pantallas y Ventana de inicio. Usuarios habilitados sólo consultan su dominio cliente; el servidor impone dominio propio. Superadmin puede consultar todos.

El panel utiliza únicamente el menú principal de Asisto. Se eliminó la barra lateral interna y su espacio reservado.

Detalle y CSV: columna única Ventana o consulta. Consulta no vacía muestra su texto omitiendo ventana de origen; en consultas por ventana muestra el nombre técnico.

Ventanas más consultadas excluye los registros que contienen una consulta textual, aunque tengan ventana de origen.

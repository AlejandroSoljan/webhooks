# Centro de actividad de la app

Disponible en Notificaciones App para todos los dominios; superadmin selecciona dominio y otros usuarios acceden sólo al suyo. Incluye resumen, gráficos por día (por hora para un solo día), ficha de cada celular, historial de sesiones/acciones y envíos con seguimiento de apertura.

GET `/api/customer-notifications/:tenant/center/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`: rango inclusivo en hora Argentina, máximo 366 días. Primer registro agrupa identidades sin inferir fecha de instalación; actividad cuenta eventos, no registros de token. Cada gráfico tiene escala propia y tabla de valores. Ficha `/center/devices/:id`: últimos 100 eventos de todos los identificadores vinculados. Resumen adicional de siete días y últimos 100 envíos conservados en pestañas.

POST `/api/customer-app/:tenant/activity`: requiere instalación y token actuales, sesión válida. Eventos permitidos: apertura app, apertura notificación verificada, pantallas, inicio escáner, solicitud/cancelación de turno y consulta productos. Deduplicación de sesiones y acciones por ventanas de 30 segundos. No recibe textos de conversaciones ni contenido arbitrario. Retención de actividad/recibos 365 días con TTL. Actividad anterior sin registro no se reconstruye.

Envíos desde `/center/send` tienen idempotencia y enlace individual con secreto aleatorio cuyo hash se guarda en recibos. Sólo la instalación destinataria puede acreditar apertura. Aceptación por Firebase no prueba recepción ni lectura; envíos históricos sin seguimiento muestran sin medición. No se envían notificaciones durante las pruebas.

La web incorpora seguimiento sin requerir reinstalar. Versiones nativas antiguas sin puente/token no producen mediciones; versión y permiso desconocidos aparecen sin datos. Los eventos se capturan sólo dentro de la app. Se preservan identidad, turnos y datos existentes. El código nativo 1.0.6 sigue su revisión independiente.

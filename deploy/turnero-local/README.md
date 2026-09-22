# Nodo local del turnero

El LXC es el escritor principal de la cola y usa MongoDB local. Nginx publica el servicio en la LAN y en ZeroTier. Un sincronizador en segundo plano replica los documentos de MCN con MongoDB de AWS cuando existe conexión.

El dominio operativo es `MCN`. `DEMO_FERRETERIA` se conserva como entorno de prueba con datos separados.

- LAN: `http://192.168.0.79/`
- ZeroTier: `http://172.25.168.99/`
- Servicio Node: `127.0.0.1:3102`
- MongoDB: `127.0.0.1:27017`, base `asisto_turnero`

El kiosco, la atención y las pantallas siguen funcionando en la LAN si se corta Internet. Firebase, los celulares por 4G y cualquier recurso externo requieren Internet.

La sincronización nunca participa en la respuesta de las pantallas locales: si se corta Internet, emisión, atención, llamados e impresión continúan contra MongoDB local. Al volver la conexión, los cambios pendientes se combinan por fecha de actualización y el historial más completo, sin reemplazar un evento más nuevo.

El panel de atención acepta filtros por enlace. Sin `sector` muestra todas; por ejemplo, `?sector=ferreteria` o `?sector=Ferreteria` muestra solamente Ferretería. También acepta el nombre visible sin distinguir mayúsculas ni acentos.

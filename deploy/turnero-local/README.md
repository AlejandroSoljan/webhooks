# Nodo local del turnero

El LXC es el escritor único de la cola y usa MongoDB local. Nginx publica el servicio en la LAN y en ZeroTier. AWS podrá reenviar las rutas públicas al nodo a través de ZeroTier mientras el comercio tenga Internet.

- LAN: `http://192.168.0.79/`
- ZeroTier: `http://172.25.168.99/`
- Servicio Node: `127.0.0.1:3102`
- MongoDB: `127.0.0.1:27017`, base `asisto_turnero`

El kiosco, la atención y las pantallas siguen funcionando en la LAN si se corta Internet. Firebase, los celulares por 4G y cualquier recurso externo requieren Internet.

# Acceso de la otra PC al staging AWS

Preparado el 18/11/2026. Cuenta SSH `manager-go-dev`, host Tailscale `100.76.215.98`. La cuenta tiene un directorio de releases y permiso para activar versiones de staging. La clave pública de Gabriel ya está instalada. La clave privada permanece en la PC del desarrollador.

En la otra PC, instalar Tailscale e iniciar sesión con la cuenta que autorice el mantenedor. Generar una clave SSH propia si no existe y enviar el archivo `.pub` al mantenedor. Cuando ambos accesos estén autorizados, agregar a `~/.ssh/config` lo siguiente.

```sshconfig
Host asisto-staging
    HostName 100.76.215.98
    User manager-go-dev
    IdentityFile ~/.ssh/asisto_staging
    IdentitiesOnly yes
    LocalForward 13101 127.0.0.1:3101
```

Abrir `ssh asisto-staging` y mantenerlo conectado para entrar desde el navegador a `http://127.0.0.1:13101`. Las credenciales del panel deben crearse en la base de staging. Las cookies se vinculan al host, por lo que conviene usar un perfil de navegador dedicado para ese panel.

## Subir una versión para probar

El operador trabaja con un commit y cambios guardados en Git. Desde la raíz del checkout puede empaquetar sólo los archivos versionados. Reemplazar `COMMIT` y `RELEASE` por el commit y un nombre único simple como `manager-go-abc1234`. Si el directorio ya existe, usar otro nombre.

```powershell
git archive --format=tar -o manager-go-staging.tar COMMIT
scp manager-go-staging.tar asisto-staging:/home/manager-go-dev/
ssh asisto-staging
```

En la sesión Linux, preparar dependencias como el usuario de despliegue y activar el release.

```bash
mkdir /opt/asisto-staging/developer/releases/RELEASE
tar -xf ~/manager-go-staging.tar -C /opt/asisto-staging/developer/releases/RELEASE
cd /opt/asisto-staging/developer/releases/RELEASE
npm ci
sudo /usr/local/sbin/asisto-staging-activate RELEASE
curl -fsS http://127.0.0.1:3101/healthz
```

El activador serializa despliegues, cambia el enlace de staging, reinicia ese servicio y verifica `/healthz`. Si la comprobación falla, restaura el enlace anterior y vuelve a iniciar el servicio. Para volver a una versión del directorio del desarrollador, ejecutar el activador con su nombre. Revisar el release activo antes de cada despliegue, porque staging es compartido. Las dependencias deben instalarse con permisos de lectura para el servicio `asisto-staging`, como ocurre con la umask habitual 022.

## Estado de verificación

El mantenedor verificó la configuración de SSH, la sintaxis del activador, el rechazo de un nombre de release inválido, el permiso sudo limitado al activador y `/healthz` de staging. Falta la prueba de inicio de sesión y de despliegue desde la otra PC. El primer despliegue también debe verificar el arranque real de Manager Go y su operación de ejemplo. El servicio usa base `asisto_staging`, namespace privado, límites de recursos y archivos productivos inaccesibles.

## Publicar en producción desde la otra PC

Por autorización del responsable de Asisto del 19/11/2026, `manager-go-dev` también puede ejecutar el desplegador productivo existente sin argumentos. Tras integrar y verificar el commit en `main`, ejecutar en AWS.

```bash
sudo /usr/local/sbin/asisto-auto-deploy
curl -fsS http://127.0.0.1:3000/healthz
readlink -f /opt/asisto/current
```

El comando descarga `main`, instala dependencias, ejecuta las pruebas, activa el release y comprueba la salud del servicio. El proceso incluye recuperación al release anterior si falla la comprobación. La publicación abarca el backend compartido y afecta a sus dominios. Seguir las reglas de versión, historial y verificación de AGENTS.md. El acceso SSH a AWS y el permiso de escritura o integración en GitHub se administran por separado.

Se validó el permiso mediante `sudo -l` con el usuario de despliegue y la sintaxis de sudoers. Al habilitar este permiso se comprobó `/healthz` de producción. El comando de publicación no se ejecutó como parte del alta del permiso.

## Coordinar las dos PC

Cada cambio tiene una rama y un PR. Con trabajo de Gabriel en curso, incorporá origin/main en esa rama y resolvé diferencias antes de probar. Staging es compartido: verificá su release antes de activarlo y registrá en el PR el commit probado, la prueba funcional y el resultado. Para integrar se necesita la revisión de otra persona y el CI de Node 24. Al publicar, compará el prefijo del release activo con el SHA integrado en main y verificá la función además de /healthz.

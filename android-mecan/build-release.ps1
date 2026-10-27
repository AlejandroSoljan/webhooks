$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'C:\Asisto\android-toolchain\jdk\jdk-17.0.20.1+1'
$env:ANDROID_HOME = 'C:\Asisto\android-toolchain\android-sdk'
$signingDir = 'C:\Asisto\android-signing\mecan'
$storePath = Join-Path $signingDir 'mecan-upload.p12'
$credentialPath = Join-Path $signingDir 'password.windows.xml'
$gradlePath = 'C:\Users\usuario\.gradle\wrapper\dists\gradle-8.11.1-bin\bpt9gzteqjrbo1mjrsomdt32c\gradle-8.11.1\bin\gradle.bat'
if (!(Test-Path $signingDir)) { New-Item -ItemType Directory $signingDir | Out-Null }
if (!(Test-Path $storePath)) {
    if (Test-Path $credentialPath) { throw 'Existe una credencial sin clave: revisar antes de generar otra.' }
    $randomBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($randomBytes)
    $env:MECAN_UPLOAD_PASSWORD = [Convert]::ToBase64String($randomBytes)
    $credential = New-Object System.Management.Automation.PSCredential('mecan-upload', (ConvertTo-SecureString $env:MECAN_UPLOAD_PASSWORD -AsPlainText -Force))
    $credential | Export-Clixml -LiteralPath $credentialPath
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $storePath -storetype PKCS12 -storepass:env MECAN_UPLOAD_PASSWORD -keypass:env MECAN_UPLOAD_PASSWORD -alias mecan-upload -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Mecan Upload, OU=Asisto, O=MANAGER SOFTWARE DE GESTION S.R.L., C=AR'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la clave de carga.' }
}
if (!(Test-Path $credentialPath)) { throw 'Falta la contraseña protegida de la clave existente.' }
$env:MECAN_UPLOAD_STORE = $storePath
$env:MECAN_UPLOAD_PASSWORD = (Import-Clixml -LiteralPath $credentialPath).GetNetworkCredential().Password
Push-Location $PSScriptRoot
try {
    & $gradlePath --no-daemon bundleRelease assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación release.' }
    & "$env:JAVA_HOME\bin\keytool.exe" -exportcert -rfc -keystore $storePath -storepass:env MECAN_UPLOAD_PASSWORD -alias mecan-upload -file (Join-Path $signingDir 'mecan-upload-certificate.pem')
} finally {
    Pop-Location
    Remove-Item Env:MECAN_UPLOAD_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:MECAN_UPLOAD_STORE -ErrorAction SilentlyContinue
}

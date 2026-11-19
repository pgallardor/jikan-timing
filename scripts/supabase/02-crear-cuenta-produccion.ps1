param(
    [string]$Email = 'operador@resultadospv.com'
)

$ErrorActionPreference = 'Stop'

if ($Email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
    throw "El correo no parece válido: $Email"
}

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'No encontré node.exe en PATH. Instala Node.js y vuelve a intentarlo.'
}

$provisioner = Join-Path $PSScriptRoot 'crear-cuenta-produccion.mjs'
if (-not (Test-Path $provisioner)) {
    throw "No encontré el script de provisión: $provisioner"
}
if (-not (Test-Path (Join-Path $appRoot 'node_modules\@supabase\supabase-js'))) {
    throw 'No encontré @supabase/supabase-js. Ejecuta pnpm install dentro de web-cronometraje y vuelve a intentarlo.'
}

Write-Host "Cuenta de producción: $Email"
Write-Host 'La contraseña se solicitará sin mostrarla y no se guardará en un archivo.'
Write-Host 'Si la cuenta ya está confirmada, el script no cambiará su contraseña.'

$passwordSecure = Read-Host 'Contraseña (mínimo 12 caracteres)' -AsSecureString
$confirmSecure = Read-Host 'Repite la contraseña' -AsSecureString

function ConvertFrom-SecureStringToPlainText([System.Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$password = ConvertFrom-SecureStringToPlainText $passwordSecure
$confirmation = ConvertFrom-SecureStringToPlainText $confirmSecure
$passwordSecure.Dispose()
$confirmSecure.Dispose()

if ($password.Length -lt 12) {
    $password = $null
    $confirmation = $null
    throw 'La contraseña debe tener al menos 12 caracteres.'
}
if ($password -cne $confirmation) {
    $password = $null
    $confirmation = $null
    throw 'Las contraseñas no coinciden. No se modificó la cuenta.'
}

$env:SUPABASE_TELEMETRY_DISABLED = '1'
$env:RFIDTIMING_SUPABASE_EMAIL = $Email
$env:RFIDTIMING_INITIAL_PASSWORD = $password
$password = $null
$confirmation = $null

try {
    Set-Location $appRoot
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $node.Source $provisioner
    $provisionExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($provisionExitCode -ne 0) {
        throw 'No se pudo crear o activar la cuenta de producción. Revisa el mensaje anterior.'
    }
}
finally {
    if ($null -ne $previousErrorActionPreference) {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Remove-Item Env:RFIDTIMING_INITIAL_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:RFIDTIMING_SUPABASE_EMAIL -ErrorAction SilentlyContinue
}

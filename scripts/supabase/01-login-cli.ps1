$ErrorActionPreference = 'Stop'

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pnpmStore = Join-Path $appRoot 'node_modules\.pnpm'
$cliPath = Get-ChildItem -Path $pnpmStore -Directory -Filter 'supabase@*' |
    ForEach-Object {
        $candidate = Join-Path $_.FullName 'node_modules\supabase\dist\supabase.js'
        if (Test-Path $candidate) { $candidate }
    } |
    Select-Object -First 1

if (-not $cliPath) {
    throw 'No encontré Supabase CLI en node_modules. Ejecuta pnpm install dentro de web-cronometraje y vuelve a intentarlo.'
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'No encontré node.exe en PATH. Instala Node.js y vuelve a intentarlo.'
}

$env:SUPABASE_TELEMETRY_DISABLED = '1'
Set-Location $appRoot

Write-Host 'Se abrirá el inicio de sesión de Supabase CLI.'
Write-Host 'Si solicita un access token, pégalo únicamente en esta consola; no lo compartas por chat.'
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $node.Source $cliPath login
$loginExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($loginExitCode -ne 0) {
    throw 'No se completó el inicio de sesión de Supabase CLI.'
}

Write-Host ''
Write-Host 'Sesión iniciada. Verificando acceso a proyectos...'
$ErrorActionPreference = 'Continue'
& $node.Source $cliPath projects list
$projectsExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($projectsExitCode -ne 0) {
    throw 'La sesión no pudo consultar proyectos. Revisa el inicio de sesión y los permisos de tu cuenta.'
}

Write-Host ''
Write-Host 'Listo. Ahora ejecuta 02-crear-cuenta-produccion.ps1.' -ForegroundColor Green

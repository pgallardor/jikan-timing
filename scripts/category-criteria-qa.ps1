param([ValidateSet('Init','Build','Start','Test','Demo','Stop')][string]$Action = 'Test')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$taskQaDirectory = 'local-backups/category-criteria-qa'
if ($Action -eq 'Init') {
  New-Item -ItemType Directory -Force "$taskQaDirectory/supabase/migrations" | Out-Null
  $taskConfig = Get-Content -Raw supabase/config.toml
  $taskConfig = $taskConfig.Replace('crono-local','crono-criteria-synthetic') -replace '5432([0-6])','5542$1'
  $taskConfig = $taskConfig.Replace('inspector_port = 8083','inspector_port = 8183') + "`n[db.seed]`nenabled = false`n"
  [IO.File]::WriteAllText((Join-Path (Get-Location) "$taskQaDirectory/supabase/config.toml"),$taskConfig)
  Copy-Item supabase/migrations/*.sql "$taskQaDirectory/supabase/migrations/"
  Copy-Item supabase/functions "$taskQaDirectory/supabase/" -Recurse -Force
  pnpm exec supabase start --workdir $taskQaDirectory --exclude vector,studio,imgproxy,logflare,realtime,edge-runtime
  if ($LASTEXITCODE) { throw 'No se pudo iniciar Supabase sintético.' }
  exit
}
if ($Action -eq 'Stop') { pnpm exec supabase stop --workdir $taskQaDirectory; exit }
$taskQa = pnpm exec supabase status --workdir $taskQaDirectory --output json | ConvertFrom-Json
if ($taskQa.API_URL -ne 'http://127.0.0.1:55421') { throw 'Esta tarea solo puede usar la base sintética aislada.' }
$env:NEXT_PUBLIC_SUPABASE_URL = $taskQa.API_URL
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $taskQa.ANON_KEY
$env:OPERATOR_SUPABASE_URL = $taskQa.API_URL
$env:OPERATOR_SUPABASE_KEY = $taskQa.ANON_KEY
switch ($Action) {
  'Build' { pnpm build; if ($LASTEXITCODE) { throw 'Falló la compilación web.' } }
  'Start' { pnpm start --hostname 127.0.0.1 --port 3100 }
  'Test' {
    Invoke-WebRequest 'http://127.0.0.1:3100/login' -TimeoutSec 10 | Out-Null
    dotnet build ../RFIDLocal/tests/CriteriaBridge.csproj -o ../RFIDLocal/bin/CriteriaQA --ignore-failed-sources --verbosity quiet
    if ($LASTEXITCODE) { throw 'Falló el puente C#.' }
    pnpm test:operator
    if ($LASTEXITCODE) { throw 'Fallaron las pruebas de lógica.' }
    pnpm test:operator:local
    if ($LASTEXITCODE) { throw 'Fallaron las pruebas de integración.' }
  }
  'Demo' { node scripts/seed-category-demo.cjs; if ($LASTEXITCODE) { throw 'Falló la preparación de la demo.' } }
}

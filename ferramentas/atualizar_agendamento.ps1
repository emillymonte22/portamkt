# Aplica no Job do Databricks o horário, o tempo máximo e a descrição de databricks/job.json.
# Uso (na pasta do projeto):  powershell -ExecutionPolicy Bypass -File ferramentas\atualizar_agendamento.ps1
# Não mexe no notebook nem roda o Job. Precisa do Databricks CLI logado (perfil DEFAULT, emillymonte@bemol.com.br).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$JOB_ID = 1025737974527673

$db = (Get-Command databricks -ErrorAction SilentlyContinue).Source
if (-not $db) {
    $db = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter databricks.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $db) { throw 'Databricks CLI não encontrado' }

$cfg = Get-Content databricks/job.json -Raw -Encoding utf8 | ConvertFrom-Json
$pedido = @{
    job_id = $JOB_ID
    new_settings = @{ schedule = $cfg.schedule; timeout_seconds = $cfg.timeout_seconds; description = $cfg.description }
} | ConvertTo-Json -Depth 5
$tmp = Join-Path $env:TEMP 'portamkt_job_update.json'
[IO.File]::WriteAllText($tmp, $pedido, (New-Object Text.UTF8Encoding $false))

& $db jobs update --json "@$tmp"
if ($LASTEXITCODE) { throw 'Falhou ao atualizar o Job' }
$agora = (& $db jobs get $JOB_ID --output json | ConvertFrom-Json).settings.schedule
Write-Host "Job atualizado: $($agora.quartz_cron_expression) ($($agora.timezone_id)), $($agora.pause_status)" -ForegroundColor Green

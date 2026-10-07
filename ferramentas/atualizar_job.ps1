# Reenvia databricks/sync_d1.py ao Databricks (notebook do Job) e roda o Job uma vez.
# Uso (na pasta do projeto):  powershell -ExecutionPolicy Bypass -File ferramentas\atualizar_job.ps1
#   -SemRodar: só envia o notebook (o Job roda no horário dele, 8h de Manaus)
# Precisa do Databricks CLI logado (perfil DEFAULT, usuário emillymonte@bemol.com.br).
param([switch]$SemRodar)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$db = (Get-Command databricks -ErrorAction SilentlyContinue).Source
if (-not $db) {
    $db = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter databricks.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $db) { throw 'Databricks CLI não encontrado' }

$env:MSYS_NO_PATHCONV = 1
& $db workspace import /Users/emillymonte@bemol.com.br/portamkt/sync_d1 --file databricks/sync_d1.py --language PYTHON --format SOURCE --overwrite
if ($LASTEXITCODE) { throw 'Falhou ao enviar o notebook' }
Write-Host 'Notebook atualizado no Databricks.' -ForegroundColor Green
if ($SemRodar) { Write-Host 'Job não iniciado (-SemRodar): roda no horário dele.' -ForegroundColor Yellow; return }

& $db jobs run-now 1025737974527673 --no-wait
if ($LASTEXITCODE) { throw 'Falhou ao iniciar o Job' }
Write-Host 'Job iniciado (leva alguns minutos).' -ForegroundColor Green

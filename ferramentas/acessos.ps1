# Cadastro de acessos do portal (login pelo e-mail). A senha é gerada aqui, aparece UMA vez na tela e vai para o
# banco já em hash (PBKDF2, igual ao functions/[[path]].js): ninguém consegue ver a senha depois, nem no banco.
# Uso (na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File ferramentas\acessos.ps1 -Listar
#   powershell -ExecutionPolicy Bypass -File ferramentas\acessos.ps1 -Criar  -Email cd@bemol.com.br -Perfil cd
#   powershell -ExecutionPolicy Bypass -File ferramentas\acessos.ps1 -NovaSenha -Email cd@bemol.com.br
#   powershell -ExecutionPolicy Bypass -File ferramentas\acessos.ps1 -Remover -Email cd@bemol.com.br
# Perfis: admin, cd, comercial. -Local usa o banco de teste do computador em vez do banco real.
param(
    [switch]$Listar, [switch]$Criar, [switch]$NovaSenha, [switch]$Remover,
    [string]$Email, [ValidateSet('admin', 'cd', 'comercial')][string]$Perfil, [switch]$Local
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$ITERACOES = 100000  # PBKDF2_ITERACOES em functions/[[path]].js

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    $node = Get-ChildItem "$env:LOCALAPPDATA\pmkt" -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { throw 'Node.js não encontrado (instale ou use o Node portátil em %LOCALAPPDATA%\pmkt)' }
    $env:Path = "$($node.FullName);$env:Path"
}
$onde = if ($Local) { '--local' } else { '--remote' }

function D1([string]$sql) {
    $saida = npx -y wrangler@4.147.0 d1 execute portamkt-db $onde --json --command $sql 2>$null
    if ($LASTEXITCODE) { throw "Falhou no banco: $sql" }
    ($saida | Out-String | ConvertFrom-Json)[0].results
}

function Base64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }

function HashSenha([string]$senha) {
    $sal = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($sal)
    $pb = New-Object Security.Cryptography.Rfc2898DeriveBytes(
        [Text.Encoding]::UTF8.GetBytes($senha), $sal, $ITERACOES, [Security.Cryptography.HashAlgorithmName]::SHA256)
    "pbkdf2`$$ITERACOES`$$(Base64Url $sal)`$$(Base64Url $pb.GetBytes(32))"
}

# 14 caracteres com maiúsculas, minúsculas, números e símbolo (sem letras que se confundem, como O/0 e l/1)
function GerarSenha {
    $grupos = 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '#@!%*+?'
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $byte = New-Object byte[] 1
    $sorteia = { param($t) do { $rng.GetBytes($byte) } while ($byte[0] -ge 256 - (256 % $t.Length)); $t[$byte[0] % $t.Length] }
    $letras = @($grupos | ForEach-Object { & $sorteia $_ }) + @(1..10 | ForEach-Object { & $sorteia ($grupos -join '') })
    -join ($letras | Sort-Object { $rng.GetBytes($byte); $byte[0] })
}

function ConferirEmail {
    if (-not $Email) { throw 'Informe -Email' }
    $script:Email = $Email.Trim().ToLower()
    if ($Email -notmatch '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$') { throw "E-mail inválido: $Email" }
}

function MostrarSenha($senha) {
    Write-Host ''
    Write-Host "  Login: $Email" -ForegroundColor Cyan
    Write-Host "  Senha: $senha" -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Esta senha aparece só agora. Passe para a pessoa por um canal privado (Teams, pessoalmente).' -ForegroundColor Yellow
}

if ($Listar) {
    D1 'SELECT username AS login, perfil FROM usuarios ORDER BY perfil, username' | Format-Table -AutoSize
} elseif ($Criar) {
    ConferirEmail
    if (-not $Perfil) { throw 'Informe -Perfil (admin, cd ou comercial)' }
    if (D1 "SELECT 1 FROM usuarios WHERE username = '$Email'") { throw "$Email já tem acesso. Para trocar a senha, use -NovaSenha." }
    $senha = GerarSenha
    D1 "INSERT INTO usuarios (username, senha, perfil) VALUES ('$Email', '$(HashSenha $senha)', '$Perfil')" | Out-Null
    Write-Host "Acesso criado ($Perfil)." -ForegroundColor Green
    MostrarSenha $senha
} elseif ($NovaSenha) {
    ConferirEmail
    if (-not (D1 "SELECT 1 FROM usuarios WHERE username = '$Email'")) { throw "$Email não tem acesso." }
    $senha = GerarSenha
    D1 "UPDATE usuarios SET senha = '$(HashSenha $senha)' WHERE username = '$Email'" | Out-Null
    Write-Host 'Senha trocada. Quem estava logado com a senha antiga sai na hora.' -ForegroundColor Green
    MostrarSenha $senha
} elseif ($Remover) {
    ConferirEmail
    if (-not (D1 "SELECT 1 FROM usuarios WHERE username = '$Email'")) { throw "$Email não tem acesso." }
    D1 "DELETE FROM usuarios WHERE username = '$Email'" | Out-Null
    Write-Host "Acesso de $Email removido (sai do portal na hora)." -ForegroundColor Green
} else {
    Get-Content $PSCommandPath -TotalCount 8 | Select-Object -Skip 2
}

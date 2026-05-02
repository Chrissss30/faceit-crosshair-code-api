# atualizar-cookie-vps.ps1
# Copia o FACEIT_WEB_COOKIE do .env local para a VPS automaticamente

$VPS_IP = "76.13.232.65"
$VPS_USER = "root"
$VPS_ENV = "/root/faceit-crosshair-code-api/.env"
$LOCAL_ENV = "$PSScriptRoot\.env"

# Le o cookie do .env local
$cookie = Get-Content $LOCAL_ENV | Where-Object { $_ -match "^FACEIT_WEB_COOKIE=" } | ForEach-Object { $_ -replace "^FACEIT_WEB_COOKIE=", "" }

if (-not $cookie) {
    Write-Host "ERRO: FACEIT_WEB_COOKIE nao encontrado no .env local." -ForegroundColor Red
    exit 1
}

Write-Host "Cookie encontrado ($($cookie.Length) chars). Enviando para a VPS..." -ForegroundColor Cyan

# Atualiza o cookie na VPS via SSH
$escapedCookie = $cookie -replace "'", "'\''"
ssh "${VPS_USER}@${VPS_IP}" "sed -i 's|^FACEIT_WEB_COOKIE=.*|FACEIT_WEB_COOKIE=${escapedCookie}|' ${VPS_ENV} && pm2 restart crosshair-api --update-env"

Write-Host "Cookie atualizado com sucesso na VPS!" -ForegroundColor Green
Write-Host "Testando API..." -ForegroundColor Cyan

Start-Sleep -Seconds 3
$result = Invoke-RestMethod -Uri "http://${VPS_IP}:3010/api/crosshair/honda21?refresh=1" -ErrorAction SilentlyContinue
Write-Host "Resultado: $result" -ForegroundColor Yellow

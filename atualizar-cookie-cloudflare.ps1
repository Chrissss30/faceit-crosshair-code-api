# atualizar-cookie-cloudflare.ps1
# Atualiza o FACEIT_COOKIE no Cloudflare Worker automaticamente
# Requer: CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID configurados abaixo

# ============================================================
# CONFIGURE AQUI
$CLOUDFLARE_API_TOKEN = "seu_token_aqui"   # dash.cloudflare.com -> Profile -> API Tokens
$CLOUDFLARE_ACCOUNT_ID = "seu_account_id"  # dash.cloudflare.com -> lado direito da tela
$WORKER_NAME = "crossfaceit"
$LOCAL_ENV = "$PSScriptRoot\.env"
# ============================================================

# Le o cookie do .env local
$cookie = Get-Content $LOCAL_ENV | Where-Object { $_ -match "^FACEIT_WEB_COOKIE=" } | ForEach-Object { $_ -replace "^FACEIT_WEB_COOKIE=", "" }

if (-not $cookie) {
    Write-Host "ERRO: FACEIT_WEB_COOKIE nao encontrado no .env local." -ForegroundColor Red
    Write-Host "Atualize o FACEIT_WEB_COOKIE no arquivo .env primeiro." -ForegroundColor Yellow
    exit 1
}

Write-Host "Cookie encontrado ($($cookie.Length) chars)." -ForegroundColor Cyan

# Pega apenas os cookies essenciais para nao ultrapassar o limite de 5.1kb do Cloudflare
$essentialCookies = ($cookie -split "; ") | Where-Object {
    $_ -match "^(__Host-AuthSession|__Host-FaceitGatewayAuthorization|cf_clearance)="
}

if ($essentialCookies.Count -eq 0) {
    Write-Host "ERRO: Cookies essenciais nao encontrados. Verifique se o cookie esta completo." -ForegroundColor Red
    exit 1
}

$trimmedCookie = $essentialCookies -join "; "
Write-Host "Cookies essenciais extraidos ($($trimmedCookie.Length) chars)." -ForegroundColor Cyan

# Atualiza o secret no Cloudflare Worker via API
$headers = @{
    "Authorization" = "Bearer $CLOUDFLARE_API_TOKEN"
    "Content-Type"  = "application/json"
}

$body = @{
    name  = "FACEIT_COOKIE"
    text  = $trimmedCookie
} | ConvertTo-Json

$url = "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets"

try {
    $response = Invoke-RestMethod -Uri $url -Method Put -Headers $headers -Body $body
    if ($response.success) {
        Write-Host "Cookie atualizado com sucesso no Cloudflare Worker!" -ForegroundColor Green
    } else {
        Write-Host "Erro ao atualizar: $($response.errors | ConvertTo-Json)" -ForegroundColor Red
    }
} catch {
    Write-Host "Erro na requisicao: $_" -ForegroundColor Red
}

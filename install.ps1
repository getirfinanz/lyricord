# Installs the helper: npm dependencies, Discord Application ID, start at login, start now.
# Usage (PowerShell, in this folder):  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$helper = Join-Path $root 'helper'

Write-Host "`nLyricord kurulumu`n" -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js bulunamadı. https://nodejs.org adresinden LTS sürümünü kurup bu betiği tekrar çalıştır." -ForegroundColor Red
  exit 1
}
Write-Host "Node.js $(node --version) bulundu."

# 2. Dependencies
Push-Location $helper
npm install --omit=dev --no-fund --no-audit
Pop-Location

# 3. Discord Application ID
$configPath = Join-Path $helper 'config.json'
$existing = $null
if (Test-Path $configPath) { $existing = (Get-Content $configPath -Raw | ConvertFrom-Json).clientId }
if ($existing -match '^\d{17,20}$') {
  Write-Host "Kayıtlı Application ID kullanılıyor: $existing"
} else {
  Write-Host "`nDiscord Developer Portal'da (https://discord.com/developers/applications)"
  Write-Host "'New Application' ile 'Lyricord' adında bir uygulama oluştur ve Application ID'yi kopyala."
  do { $id = (Read-Host "Application ID").Trim() } until ($id -match '^\d{17,20}$')
  @{ clientId = $id } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
}

# 4. Start at login (hidden, no console window)
$startup = [Environment]::GetFolderPath('Startup')
# Older versions named the launcher 'Muzik Discord.vbs'.
Remove-Item (Join-Path $startup 'Muzik Discord.vbs') -ErrorAction SilentlyContinue
$launcher = Join-Path $startup 'Lyricord.vbs'
$vbsTarget = Join-Path $helper 'start-hidden.vbs'
"CreateObject(""WScript.Shell"").Run ""wscript.exe """"$vbsTarget"""""", 0, False" | Set-Content $launcher -Encoding ASCII
Write-Host "Windows açılışında otomatik başlayacak: $launcher"

# 5. Start now
Start-Process wscript.exe -ArgumentList "`"$vbsTarget`""
Start-Sleep -Seconds 3
try {
  $s = Invoke-RestMethod http://127.0.0.1:48231/status
  if ($s.discord) { Write-Host "Yardımcı çalışıyor ve Discord'a bağlı ($($s.user))." -ForegroundColor Green }
  else { Write-Host "Yardımcı çalışıyor. Discord açılınca kendiliğinden bağlanacak." -ForegroundColor Yellow }
} catch {
  Write-Host "Yardımcı başlatılamadı, ayrıntılar için helper\helper.log dosyasına bak." -ForegroundColor Red
}

Write-Host "`nSon adım: chrome://extensions sayfasında Geliştirici modunu aç,"
Write-Host "'Paketlenmemiş öğe yükle' ile şu klasörü seç: $(Join-Path $root 'extension')`n"

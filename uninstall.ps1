# Stops the helper and removes the start-at-login entry. The extension is removed from chrome://extensions.
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'Lyricord.vbs') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startup 'Muzik Discord.vbs') -ErrorAction SilentlyContinue # older versions
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$PSScriptRoot*server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Yardımcı durduruldu ve otomatik başlatma kaldırıldı. Eklentiyi chrome://extensions sayfasından kaldırabilirsin."

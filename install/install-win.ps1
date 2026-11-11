# Uni-Assist 2FA OTP host installer (Windows)
#   powershell -ExecutionPolicy Bypass -File install\install-win.ps1
#   powershell -ExecutionPolicy Bypass -File install\install-win.ps1 -Uninstall
#
# Messages are ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"

$HostName = "com.unipost.approval_otp"
$Root = Split-Path -Parent $PSScriptRoot
$HostDir = Join-Path $Root "host"
$Launcher = Join-Path $HostDir "host.bat"
$Manifest = Join-Path $HostDir "$HostName.json"
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

function Fail([string]$Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) { Fail "Node.js was not found. Install Node.js 20.11 or later." }
$NodeBin = $NodeCommand.Source

if ($Uninstall) {
  if (Test-Path $RegistryKey) { Remove-Item -Path $RegistryKey -Force }
  Remove-Item -Path $Manifest, $Launcher -Force -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $HostDir "node_modules")) {
    & $NodeBin (Join-Path $HostDir "setup-credentials.js") --remove
  } else {
    Write-Host "host\node_modules is missing, so saved passwords were not removed."
  }
  Write-Host "Uninstalled."
  exit 0
}

$Version = (& $NodeBin -p "process.versions.node").Trim().Split(".")
$Major = [int]$Version[0]
$Minor = [int]$Version[1]
if ($Major -lt 20 -or ($Major -eq 20 -and $Minor -lt 11)) {
  Fail "Node.js 20.11 or later is required."
}

Write-Host "1/4 Installing dependencies"
Push-Location $HostDir
try {
  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }
} finally {
  Pop-Location
}

$Config = Join-Path $HostDir "config.json"
if (-not (Test-Path $Config)) { Copy-Item (Join-Path $HostDir "config.example.json") $Config }

Write-Host ""
# Fixed by the "key" in manifest.json. Type another ID only if you installed it differently.
$DefaultExtensionId = "fjmhmlhmfiomcjplmoehjmjbfeehhmmj"
Write-Host "2/4 Extension ID"
Write-Host "    Press Enter to use the fixed ID ($DefaultExtensionId)."
$ExtensionId = (Read-Host "Extension ID").Trim()
if (-not $ExtensionId) { $ExtensionId = $DefaultExtensionId }

Write-Host "3/4 Registering host"
# Chrome does not read the shell PATH reliably, so call node by absolute path.
$Batch = "@echo off`r`n`"$NodeBin`" `"%~dp0host.js`" %*`r`n"
[System.IO.File]::WriteAllText($Launcher, $Batch, [System.Text.Encoding]::Default)

& $NodeBin (Join-Path $Root "install\render-manifest.mjs") `
  (Join-Path $Root "install\host-manifest.template.json") $Manifest $Launcher $ExtensionId
if ($LASTEXITCODE -ne 0) { Fail "Could not create the host manifest." }

New-Item -Path $RegistryKey -Force | Out-Null
Set-Item -Path $RegistryKey -Value $Manifest

Write-Host "4/4 Saving passwords to Windows Credential Manager (input is hidden)"
& $NodeBin (Join-Path $HostDir "setup-credentials.js")
if ($LASTEXITCODE -ne 0) { Fail "Could not save passwords." }

Write-Host ""
Write-Host "Done. Fill in host\config.json, then reload the extension."

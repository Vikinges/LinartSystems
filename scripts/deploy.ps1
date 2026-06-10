# Deploy LinartSystems: commit -> push -> Portainer webhook -> wait for new version
# Usage:  .\scripts\deploy.ps1                      (auto commit message)
#         .\scripts\deploy.ps1 -Message "fix: ..."  (custom message)
param([string]$Message = "")

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$webhook = "https://lsc-led.de:9443/api/stacks/webhooks/b903907f-2110-4593-963b-e0f71779e249"
$health  = "https://lsc-led.de/service2/health"

# 1. Commit local changes (if any) and push
$status = git status --porcelain
if ($status) {
    if (-not $Message) { $Message = "deploy: " + (Get-Date -Format "yyyy-MM-dd HH:mm") }
    git add -A
    git commit -m $Message
}
git push

# 2. Remember current version/uptime
$oldVersion = ""
try { $oldVersion = (curl.exe -s -m 10 $health | ConvertFrom-Json).version } catch {}
Write-Host "Current version on server: $oldVersion"

# 3. Trigger Portainer webhook (-k: self-signed cert on :9443)
Write-Host "Triggering Portainer webhook..."
curl.exe -k -s -m 30 -X POST $webhook | Out-Null

# 4. Wait until container restarts (version changes OR uptime resets)
Write-Host "Waiting for redeploy (up to 5 min)..."
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 10
    try {
        $h = curl.exe -s -m 10 "$health`?t=$(Get-Random)" | ConvertFrom-Json
        Write-Host ("  health: v{0}, uptime {1}s" -f $h.version, [int]$h.uptime)
        if (($h.version -and $h.version -ne $oldVersion) -or ($h.uptime -lt 180)) {
            Write-Host ("DEPLOYED: {0} -> {1}" -f $oldVersion, $h.version) -ForegroundColor Green
            exit 0
        }
    } catch { Write-Host "  waiting..." }
}
Write-Host "No restart detected after 5 min - check Portainer stack logs." -ForegroundColor Yellow
exit 1

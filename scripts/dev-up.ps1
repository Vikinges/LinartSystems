$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $repoRoot

$envPath = Join-Path $repoRoot '.env'
$examplePath = Join-Path $repoRoot '.env.example'

if (-not (Test-Path $envPath)) {
  if (Test-Path $examplePath) {
    Copy-Item $examplePath $envPath
    Write-Host "[dev-up] Created .env from .env.example. Update secrets if needed."
  } else {
    Write-Host "[dev-up] Missing .env and .env.example. Aborting."
    exit 1
  }
}

docker compose --env-file .env up -d --build
docker compose --env-file .env ps

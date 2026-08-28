$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Invoke-LegacyContract([string]$cli) {
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "legacy CLI is unavailable: $cli"
  }
  $previous = $env:ASSAY_V014_CLI
  $env:ASSAY_V014_CLI = (Resolve-Path -LiteralPath $cli).Path
  Push-Location $repo
  try {
    pnpm --filter own-work test -- legacy-three-tool.test.ts
    if ($LASTEXITCODE -ne 0) { throw "legacy three-tool contract failed" }
  } finally {
    Pop-Location
    if ($null -eq $previous) {
      Remove-Item Env:ASSAY_V014_CLI -ErrorAction SilentlyContinue
    } else {
      $env:ASSAY_V014_CLI = $previous
    }
  }
}

if ($env:ASSAY_V014_CLI) {
  Invoke-LegacyContract $env:ASSAY_V014_CLI
  exit 0
}
if ($env:CI) {
  throw "CI requires ASSAY_V014_CLI to point to the built v0.14.0 CLI"
}

$assay = Join-Path (Split-Path -Parent $repo) "assay"
if (-not (Test-Path (Join-Path $assay ".git"))) {
  Write-Host "legacy-three-tool: local-only skip; sibling assay repository is unavailable"
  exit 0
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("ownwork-assay-v014-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $archive = Join-Path $temp "assay-v014.tar"
  git -C $assay archive --format=tar --output=$archive v0.14.0
  if ($LASTEXITCODE -ne 0) { throw "git archive v0.14.0 failed" }
  $source = Join-Path $temp "source"
  New-Item -ItemType Directory -Path $source | Out-Null
  tar -xf $archive -C $source
  Push-Location $source
  try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "legacy pnpm install failed" }
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "legacy build failed" }
  } finally { Pop-Location }
  Invoke-LegacyContract (Join-Path $source "packages/assay-cli/dist/cli.js")
} finally {
  $resolved = [IO.Path]::GetFullPath($temp)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -Recurse -Force -LiteralPath $resolved
  }
}

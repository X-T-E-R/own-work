$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
  pnpm typecheck
  if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
  pnpm lint
  if ($LASTEXITCODE -ne 0) { throw "lint failed" }
  pnpm test
  if ($LASTEXITCODE -ne 0) { throw "tests failed" }
  pnpm smoke
  if ($LASTEXITCODE -ne 0) { throw "smoke failed" }
  node scripts/pack-check.mjs
  if ($LASTEXITCODE -ne 0) { throw "pack check failed" }
  & (Join-Path $PSScriptRoot "legacy-three-tool.ps1")
  if ($LASTEXITCODE -ne 0) { throw "legacy contract failed" }
} finally { Pop-Location }

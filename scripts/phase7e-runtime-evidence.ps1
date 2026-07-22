[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $LaunchPath,
  [Parameter(Mandatory = $true)] [string] $OutputDirectory,
  [string[]] $LaunchArgumentList = @(),
  [Parameter(Mandatory = $true)] [string] $ScenarioPath,
  [string[]] $ScenarioArgumentList = @(),
  [string] $RepositoryRoot = (Join-Path $PSScriptRoot ".."),
  [int] $SampleMilliseconds = 50,
  [int] $IdleSeconds = 30,
  [int] $RecoverySeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $RepositoryRoot).ProviderPath
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $out) {
  if (@(Get-ChildItem -LiteralPath $out -Force).Count -ne 0) { throw "Phase 7E evidence output must be empty: $out" }
} else { New-Item -ItemType Directory -Path $out | Out-Null }
$fixtureDir = Join-Path $out "fixtures"
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
$generator = Join-Path $root "tests/fixtures/generate-scene-preset-memory-fixtures.mjs"
& node $generator --out $fixtureDir
if ($LASTEXITCODE -ne 0) { throw "fixture generator failed with exit code $LASTEXITCODE" }
& node $generator --verify
if ($LASTEXITCODE -ne 0) { throw "fixture generator verification failed with exit code $LASTEXITCODE" }
$sampler = Join-Path $root "scripts/phase7e-memory-sampler.ps1"
$samplerArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sampler,
  "-FixtureDirectory", $fixtureDir, "-OutputDirectory", $out,
  "-Generator", $generator, "-LaunchPath", $LaunchPath,
  "-ScenarioPath", $ScenarioPath, "-SampleMilliseconds", $SampleMilliseconds,
  "-IdleSeconds", $IdleSeconds, "-RecoverySeconds", $RecoverySeconds
)
if ($LaunchArgumentList.Count -gt 0) { $samplerArgs += "-LaunchArgumentList"; $samplerArgs += $LaunchArgumentList }
if ($ScenarioArgumentList.Count -gt 0) { $samplerArgs += "-ScenarioArgumentList"; $samplerArgs += $ScenarioArgumentList }
& pwsh @samplerArgs
if ($LASTEXITCODE -ne 0) { throw "memory sampler failed with exit code $LASTEXITCODE" }
$required = @("run-manifest.json", "calculations.json")
foreach ($name in $required) { if (-not (Test-Path -LiteralPath (Join-Path $out $name) -PathType Leaf)) { throw "missing required artifact: $name" } }
Write-Output "Phase 7E evidence harness completed: $out"

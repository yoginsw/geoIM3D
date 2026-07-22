param(
  [string] $AppDir = "apps/geolibre-desktop",
  [string] $Configuration = "release",
  [ValidateSet("x64", "x86", "arm64", "arm", "neutral")]
  [string] $Architecture = "x64",
  # Sideload identity defaults. Store builds must inject the JBT Partner Center
  # Name/Publisher values explicitly; do not reuse the upstream GeoLibre identity.
  [string] $Publisher = "CN=JBT",
  [string] $PublisherDisplayName = "JBT",
  [string] $Name = "",
  [string] $DisplayName = "",
  # Default package language. Every MSIX must declare one.
  [ValidatePattern('^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$')]
  [string] $Language = "ko-KR",
  [string] $CargoTargetDir = $env:CARGO_TARGET_DIR
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "MSIX packaging requires Windows and MakeAppx.exe from the Windows SDK."
}

function Get-MakeAppxPath {
  $command = Get-Command "makeappx.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $windowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $windowsKits) {
    $candidate = Get-ChildItem -Path $windowsKits -Filter "makeappx.exe" -Recurse |
      Sort-Object -Property FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw "Could not find MakeAppx.exe. Install the Windows SDK MSIX packaging tools."
}

function ConvertTo-MsixVersion([string] $Version) {
  $match = [regex]::Match($Version, "^(\d+)\.(\d+)\.(\d+)(?:[.+-].*)?$")
  if (-not $match.Success) {
    throw "MSIX version must be derived from a semver value like 1.2.3. Got '$Version'."
  }

  return "$($match.Groups[1].Value).$($match.Groups[2].Value).$($match.Groups[3].Value).0"
}

function ConvertTo-XmlText([string] $Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appRoot = Resolve-Path (Join-Path $repoRoot $AppDir)
$tauriDir = Join-Path $appRoot "src-tauri"
$targetRoot = if ([string]::IsNullOrWhiteSpace($CargoTargetDir)) {
  Join-Path $tauriDir "target"
} elseif ([IO.Path]::IsPathRooted($CargoTargetDir)) {
  $CargoTargetDir
} else {
  Join-Path $repoRoot $CargoTargetDir
}
$targetDir = Join-Path ([IO.Path]::GetFullPath($targetRoot)) $Configuration
$bundleDir = Join-Path $targetDir "bundle\msix"
$stagingDir = Join-Path $targetDir "msix-package"
$configPath = Join-Path $tauriDir "tauri.conf.json"
$cargoPath = Join-Path $tauriDir "Cargo.toml"
$backendDir = Join-Path $repoRoot "backend\geolibre_server"
$iconsDir = Join-Path $tauriDir "icons"

$config = Get-Content -Raw $configPath | ConvertFrom-Json
$productName = [string] $config.productName
if ([string]::IsNullOrWhiteSpace($DisplayName)) { $DisplayName = $productName }
$identifier = [string] $config.identifier
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = $identifier }
$version = ConvertTo-MsixVersion ([string] $config.version)

$cargo = Get-Content -Raw $cargoPath
$binaryNameMatch = [regex]::Match($cargo, '(?ms)\[package\].*?^name\s*=\s*"([^"]+)"')
if (-not $binaryNameMatch.Success) {
  throw "Could not determine the Tauri binary name from $cargoPath."
}

$binaryName = $binaryNameMatch.Groups[1].Value
$binaryPath = Join-Path $targetDir "$binaryName.exe"
$packageExecutableName = "$productName.exe"
if (-not (Test-Path $binaryPath)) {
  throw "Could not find $binaryPath. Run a Windows Tauri release build before MSIX packaging."
}

$description = "실감형 3D 플랫폼"
$assetsDir = Join-Path $stagingDir "Assets"
$backendPackageDir = Join-Path $stagingDir "backend\geolibre_server"
$manifestPath = Join-Path $stagingDir "AppxManifest.xml"
$packageName = "$productName-$($config.version)-$Architecture.msix"
$packagePath = Join-Path $bundleDir $packageName

Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stagingDir, $assetsDir, $backendPackageDir, $bundleDir | Out-Null

Copy-Item -Force $binaryPath (Join-Path $stagingDir $packageExecutableName)
Copy-Item -Force (Join-Path $repoRoot "THIRD_PARTY_NOTICES.md") $stagingDir
Copy-Item -Force (Join-Path $repoRoot "LICENSE") $stagingDir
Copy-Item -Recurse -Force (Join-Path $repoRoot "licenses") (Join-Path $stagingDir "licenses")
Copy-Item -Force (Join-Path $targetDir "*.dll") $stagingDir -ErrorAction SilentlyContinue
# Exclude local virtualenv/build artifacts before recursion. WSL venv symlinks
# such as `.venv/lib64` cannot be copied by Windows PowerShell.
Get-ChildItem -Force -Path $backendDir |
  Where-Object {
    $_.Name -notin @("venv", ".venv", "env", "dist", "build", ".pytest_cache", ".mypy_cache", ".ruff_cache", "htmlcov") -and
    $_.Name -notlike ".env*" -and
    $_.Name -notlike "*.egg-info" -and
    $_.Name -ne ".coverage" -and
    $_.Name -ne "coverage.xml" -and
    $_.Name -ne "AGENTS.md"
  } |
  Copy-Item -Recurse -Force -Destination $backendPackageDir
Get-ChildItem -Recurse -Path $backendPackageDir -Include "__pycache__", "*.pyc", "*.pyo", "tests", "test_*.py" |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$devArtifacts = @(
    ".env", ".env.*", "venv", ".venv", "env", "*.egg-info", "dist", "build",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".coverage", "coverage.xml", "htmlcov", "AGENTS.md"
)
Get-ChildItem -Recurse -Force -Path $backendPackageDir -Include $devArtifacts |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$assetNames = @(
  "Square44x44Logo.png",
  "Square150x150Logo.png",
  "StoreLogo.png"
)
foreach ($assetName in $assetNames) {
  Copy-Item -Force (Join-Path $iconsDir $assetName) (Join-Path $assetsDir $assetName)
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity
    Name="$(ConvertTo-XmlText $Name)"
    Publisher="$(ConvertTo-XmlText $Publisher)"
    Version="$(ConvertTo-XmlText $version)"
    ProcessorArchitecture="$(ConvertTo-XmlText $Architecture)" />
  <Properties>
    <DisplayName>$(ConvertTo-XmlText $DisplayName)</DisplayName>
    <PublisherDisplayName>$(ConvertTo-XmlText $PublisherDisplayName)</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="$(ConvertTo-XmlText $Language)" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="geoIM3D" Executable="$(ConvertTo-XmlText $packageExecutableName)" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="$(ConvertTo-XmlText $productName)"
        Description="$(ConvertTo-XmlText $description)"
        BackgroundColor="transparent"
        Square44x44Logo="Assets\Square44x44Logo.png"
        Square150x150Logo="Assets\Square150x150Logo.png" />

    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@

Set-Content -Path $manifestPath -Value $manifest -Encoding utf8

$makeAppx = Get-MakeAppxPath
Remove-Item -Force $packagePath -ErrorAction SilentlyContinue
& $makeAppx pack /d $stagingDir /p $packagePath /o
if ($LASTEXITCODE -ne 0) {
  throw "MakeAppx.exe failed with exit code $LASTEXITCODE."
}

Write-Host "MSIX package created at $packagePath"

if ($env:GITHUB_OUTPUT) {
  "msix_path=$packagePath" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}

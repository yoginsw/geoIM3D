[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $FixtureDirectory,
  [Parameter(Mandatory = $true)] [string] $OutputDirectory,
  [string] $Generator = "tests/fixtures/generate-scene-preset-memory-fixtures.mjs",
  [string] $LaunchPath,
  [string[]] $LaunchArgumentList = @(),
  [int] $RootPid = 0,
  [string] $ScenarioPath,
  [string[]] $ScenarioArgumentList = @(),
  [int] $Runs = 3,
  [int] $SampleMilliseconds = 50,
  [int] $IdleSeconds = 30,
  [int] $RecoverySeconds = 60,
  [switch] $KeepAppRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not ("Phase7e.NativeMemory" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Phase7e {
  public static class NativeMemory {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_MEMORY_COUNTERS_EX2 {
      public uint cb;
      public uint PageFaultCount;
      public UIntPtr PeakWorkingSetSize;
      public UIntPtr WorkingSetSize;
      public UIntPtr QuotaPeakPagedPoolUsage;
      public UIntPtr QuotaPagedPoolUsage;
      public UIntPtr QuotaPeakNonPagedPoolUsage;
      public UIntPtr QuotaNonPagedPoolUsage;
      public UIntPtr PagefileUsage;
      public UIntPtr PeakPagefileUsage;
      public UIntPtr PrivateUsage;
      public UIntPtr PrivateWorkingSetSize;
      public UIntPtr SharedCommitUsage;
    }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("psapi.dll", SetLastError=true)] private static extern bool GetProcessMemoryInfo(IntPtr process, ref PROCESS_MEMORY_COUNTERS_EX2 counters, uint size);
    public static ulong PrivateWorkingSet(uint pid) {
      const uint PROCESS_QUERY_INFORMATION = 0x0400;
      const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (process == IntPtr.Zero) throw new InvalidOperationException("process unavailable");
      try {
        var counters = new PROCESS_MEMORY_COUNTERS_EX2();
        counters.cb = (uint)Marshal.SizeOf<PROCESS_MEMORY_COUNTERS_EX2>();
        if (!GetProcessMemoryInfo(process, ref counters, counters.cb)) throw new InvalidOperationException("memory counters unavailable");
        return counters.PrivateWorkingSetSize.ToUInt64();
      } finally { CloseHandle(process); }
    }
  }
}
"@
}

$CsvColumns = @("utc_ns", "run_id", "fixture_id", "phase", "pid", "parent_pid", "process_creation_time", "process_role", "private_working_set_bytes")
$Phases = @("idle", "worker-scan", "transfer-handoff", "main-decode", "store-apply", "recovery")
$Expected = [ordered]@{
  "phase7e-feature-25000-v1.geoim3d-preset.json" = [ordered]@{ bytes = 2076286; sha256 = "77707a2c850ffdf89af45e909157cb3c7fc32fdb8a622e3dc656966cdae34dd2" }
  "phase7e-coordinate-250000-v1.geoim3d-preset.json" = [ordered]@{ bytes = 1501374; sha256 = "0c75b2a145efcfbc87cbb12ab0d6825ac9eea0a6238a3b8cc72a811732aea5f5" }
}

function Fail([string] $Message) { throw "Phase 7E sampler: $Message" }
function Median([double[]] $Values) {
  if ($null -eq $Values -or $Values.Count -eq 0) { return 0.0 }
  $sorted = @($Values | Sort-Object)
  $middle = [math]::Floor($sorted.Count / 2)
  if (($sorted.Count % 2) -eq 1) { return [double]$sorted[$middle] }
  return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2.0
}
function UtcNs() {
  $now = [DateTimeOffset]::UtcNow
  return ($now.ToUnixTimeMilliseconds() * 1000000) + [int64](($now.Ticks % [TimeSpan]::TicksPerMillisecond) * 100)
}
function Get-CreationUtc([int] $ProcessId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }
  return ([DateTime]$p.CreationDate).ToUniversalTime().ToString("o")
}
function Get-Role([string] $Name, [string] $CommandLine, [int] $ProcessId, [int] $Root) {
  if ($ProcessId -eq $Root) { return "tauri-root" }
  $n = $Name.ToLowerInvariant()
  $command = if ($null -eq $CommandLine) { "" } else { $CommandLine.ToLowerInvariant() }
  if ($n -match "msedgewebview2|webview2") {
    if ($command -match "--type=renderer(?:\s|$)") { return "webview-renderer" }
    return "webview-utility"
  }
  if ($n -match "renderer") { return "webview-renderer" }
  if ($n -match "utility|gpu|crashpad|broker") { return "webview-utility" }
  return "other-child"
}
function Get-Tree([int] $Root, [string] $RootCreation) {
  $all = @(Get-CimInstance Win32_Process)
  $byParent = @{}
  foreach ($p in $all) {
    $parent = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = [System.Collections.Generic.List[object]]::new() }
    $byParent[$parent].Add($p)
  }
  $selected = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($Root)
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    if ($byParent.ContainsKey($parent)) {
      foreach ($child in $byParent[$parent]) { $selected.Add($child); $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  $rootProcess = $all | Where-Object { [int]$_.ProcessId -eq $Root } | Select-Object -First 1
  if ($null -eq $rootProcess) { return @() }
  $entries = [System.Collections.Generic.List[object]]::new()
  $entries.Add([pscustomobject]@{ pid = $Root; parent_pid = [int]$rootProcess.ParentProcessId; name = [string]$rootProcess.Name; command_line = [string]$rootProcess.CommandLine; creation = $RootCreation })
  foreach ($candidate in $selected) {
    $creation = ([DateTime]$candidate.CreationDate).ToUniversalTime().ToString("o")
    $entries.Add([pscustomobject]@{ pid = [int]$candidate.ProcessId; parent_pid = [int]$candidate.ParentProcessId; name = [string]$candidate.Name; command_line = [string]$candidate.CommandLine; creation = $creation })
  }
  return @($entries)
}
function Sample([int] $Root, [string] $RootCreation, [string] $RunId, [string] $FixtureId, [string] $Phase, [System.Collections.Generic.List[object]] $Rows) {
  $sampleUtcNs = UtcNs
  foreach ($entry in (Get-Tree $Root $RootCreation)) {
    try {
      $process = Get-Process -Id $entry.pid -ErrorAction Stop
      $creation = $entry.creation
      $liveCreation = $process.StartTime.ToUniversalTime().ToString("o")
      if ($liveCreation -ne $creation -or ($entry.pid -eq $Root -and $creation -ne $RootCreation)) { continue }
      $Rows.Add([pscustomobject][ordered]@{
        utc_ns = $sampleUtcNs; run_id = $RunId; fixture_id = $FixtureId; phase = $Phase
        pid = $entry.pid; parent_pid = $entry.parent_pid; process_creation_time = $creation
        process_role = Get-Role $entry.name $entry.command_line $entry.pid $Root
        private_working_set_bytes = [int64][Phase7e.NativeMemory]::PrivateWorkingSet([uint32]$entry.pid)
      })
    } catch [System.Exception] { continue }
  }
}
function Run-Phase([int] $Root, [string] $RootCreation, [string] $RunId, [string] $FixtureId, [string] $Phase, [int] $Seconds, [System.Collections.Generic.List[object]] $Rows, [string] $FixturePath) {
  if ($ScenarioPath) {
    $args = @($ScenarioArgumentList + @("--phase", $Phase, "--fixture", $FixturePath, "--run-id", $RunId))
    $scenario = Start-Process -FilePath $ScenarioPath -ArgumentList $args -PassThru
    while (-not $scenario.HasExited) {
      Sample $Root $RootCreation $RunId $FixtureId $Phase $Rows
      Start-Sleep -Milliseconds $SampleMilliseconds
      $scenario.Refresh()
    }
    if ($scenario.ExitCode -ne 0) { Fail "scenario failed in phase '$Phase' with exit code $($scenario.ExitCode)" }
  }
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $until) {
    Sample $Root $RootCreation $RunId $FixtureId $Phase $Rows
    Start-Sleep -Milliseconds $SampleMilliseconds
  }
}
function Verify-Fixtures([string] $Directory, [string] $GeneratorPath) {
  if (-not (Test-Path -LiteralPath $GeneratorPath -PathType Leaf)) { Fail "generator not found: $GeneratorPath" }
  $source = Get-Content -LiteralPath $GeneratorPath -Raw
  $versionMatch = [regex]::Match($source, 'GENERATOR_VERSION\s*=\s*"([^"]+)"')
  if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne "phase7e-memory-fixtures-v1") { Fail "generator version is not phase7e-memory-fixtures-v1" }
  $sourceHash = (Get-FileHash -LiteralPath $GeneratorPath -Algorithm SHA256).Hash.ToLowerInvariant()
  & node $GeneratorPath --verify | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "generator --verify failed" }
  $files = [ordered]@{}
  foreach ($name in $Expected.Keys) {
    $path = Join-Path $Directory $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "fixture missing: $name" }
    $item = Get-Item -LiteralPath $path
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([int64]$item.Length -ne $Expected[$name].bytes -or $hash -ne $Expected[$name].sha256) { Fail "fixture identity mismatch: $name" }
    $files[$name] = [ordered]@{ bytes = [int64]$item.Length; sha256 = $hash }
  }
  return [pscustomobject]@{ generator_version = $versionMatch.Groups[1].Value; generator_sha256 = $sourceHash; node_version = (& node --version); files = $files }
}
function New-Root([int] $RequestedPid) {
  if ($RequestedPid -gt 0) {
    $creation = Get-CreationUtc $RequestedPid
    if ($null -eq $creation) { Fail "attached root PID $RequestedPid does not exist" }
    return [pscustomobject]@{ process = $null; pid = $RequestedPid; creation = $creation }
  }
  if (-not $LaunchPath) { Fail "provide -LaunchPath or -RootPid" }
  $process = Start-Process -FilePath $LaunchPath -ArgumentList $LaunchArgumentList -PassThru
  Start-Sleep -Milliseconds 500
  $creation = Get-CreationUtc $process.Id
  if ($null -eq $creation) { Fail "launched root PID $($process.Id) disappeared before binding" }
  return [pscustomobject]@{ process = $process; pid = $process.Id; creation = $creation }
}

if ($Runs -lt 1 -or $SampleMilliseconds -lt 1 -or $IdleSeconds -lt 5 -or $RecoverySeconds -lt 5) { Fail "invalid timing/run parameters" }
if ($RootPid -gt 0 -and $Runs -ne 1) { Fail "-RootPid attach mode supports exactly one run" }
if (-not (Test-Path -LiteralPath $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory | Out-Null }
$FixtureDirectory = (Resolve-Path -LiteralPath $FixtureDirectory).ProviderPath
$GeneratorPath = (Resolve-Path -LiteralPath $Generator).ProviderPath
$identity = Verify-Fixtures $FixtureDirectory $GeneratorPath
$manifest = [ordered]@{ schema = "phase7e-memory-evidence-v1"; capture_type = "windows-native-powershell"; sample_interval_ms = $SampleMilliseconds; csv_columns = $CsvColumns; thresholds = [ordered]@{ renderer_peak_bytes = 160MB; tree_peak_bytes = 192MB; recovery_delta_bytes = 32MB; recovery_monotonic = $false }; generator = $identity; runs = @() }
$allCalculations = [System.Collections.Generic.List[object]]::new()

foreach ($fixtureName in $Expected.Keys) {
  $fixturePath = Join-Path $FixtureDirectory $fixtureName
  $fixtureId = [IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFileNameWithoutExtension($fixtureName))
  for ($run = 1; $run -le $Runs; $run++) {
    $runId = "$fixtureId-run$run"
    $root = New-Root $RootPid
    $rows = [System.Collections.Generic.List[object]]::new()
    $markers = [System.Collections.Generic.List[object]]::new()
    foreach ($phase in $Phases) {
      $markers.Add([pscustomobject]@{ phase = $phase; utc_ns = UtcNs })
      $seconds = if ($phase -eq "idle") { $IdleSeconds } elseif ($phase -eq "recovery") { $RecoverySeconds } else { 1 }
      Run-Phase $root.pid $root.creation $runId $fixtureId $phase $seconds $rows $fixturePath
    }
    $csvPath = Join-Path $OutputDirectory "$runId.csv"
    $rows | Select-Object $CsvColumns | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding utf8
    $markerPath = Join-Path $OutputDirectory "$runId.markers.json"
    $markers | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $markerPath -Encoding utf8
    $idleRows = @($rows | Where-Object { $_.phase -eq "idle" -and $_.utc_ns -ge (($markers[0].utc_ns) + (($IdleSeconds - 5) * 1000000000)) })
    $baselines = @{}
    foreach ($pidGroup in @($idleRows | Group-Object pid)) { $baselines[[string]$pidGroup.Name] = Median @($pidGroup.Group.private_working_set_bytes | ForEach-Object { [double]$_ }) }
    $treeBaseline = ($baselines.Values | Measure-Object -Sum).Sum
    $rendererPeaks = @($rows | Where-Object { $_.process_role -eq "webview-renderer" } | Group-Object utc_ns | ForEach-Object {
      $sum = 0.0
      foreach ($rendererRow in $_.Group) {
        $base = if ($baselines.ContainsKey([string]$rendererRow.pid)) { $baselines[[string]$rendererRow.pid] } else { 0 }
        $sum += [math]::Max([double]$rendererRow.private_working_set_bytes - $base, 0)
      }
      $sum
    })
    $rendererPeak = [double](($rendererPeaks | Measure-Object -Maximum).Maximum); if ($rendererPeak -lt 0) { $rendererPeak = 0 }
    $treePeaks = @($rows | Group-Object utc_ns | ForEach-Object { $sum = ($_.Group | Measure-Object private_working_set_bytes -Sum).Sum; [math]::Max($sum - $treeBaseline, 0) })
    $treePeak = [double](($treePeaks | Measure-Object -Maximum).Maximum); if ($treePeak -lt 0) { $treePeak = 0 }
    $recoveryRows = @($rows | Where-Object { $_.phase -eq "recovery" -and $_.utc_ns -ge (($markers[$markers.Count - 1].utc_ns) + (($RecoverySeconds - 5) * 1000000000)) })
    $recovery = [double](($recoveryRows | Group-Object utc_ns | ForEach-Object { [math]::Max((($_.Group | Measure-Object private_working_set_bytes -Sum).Sum - $treeBaseline), 0) } | Measure-Object -Average).Average); if ($recovery -lt 0) { $recovery = 0 }
    $calc = [ordered]@{ run_id = $runId; fixture_id = $fixtureId; csv = [IO.Path]::GetFileName($csvPath); baseline_tree_bytes = [int64]$treeBaseline; renderer_peak_delta_bytes = [int64]$rendererPeak; tree_peak_delta_bytes = [int64]$treePeak; recovery_delta_bytes = [int64]$recovery; pass = ($rendererPeak -le 160MB -and $treePeak -le 192MB -and $recovery -le 32MB) }
    $allCalculations.Add([pscustomobject]$calc)
    $manifest.runs += [pscustomobject]$calc
    if ($root.process -and -not $KeepAppRunning) { Stop-Process -Id $root.pid -Force -ErrorAction SilentlyContinue }
  }
}
$monotonic = $false
foreach ($fixtureGroup in @($allCalculations | Group-Object fixture_id)) {
  $recoveryValues = @($fixtureGroup.Group | Sort-Object run_id | ForEach-Object { $_.recovery_delta_bytes })
  if ($recoveryValues.Count -lt 2) { continue }
  $fixtureMonotonic = $true
  for ($i = 1; $i -lt $recoveryValues.Count; $i++) { if ($recoveryValues[$i] -le $recoveryValues[$i - 1]) { $fixtureMonotonic = $false; break } }
  if ($fixtureMonotonic) { $monotonic = $true; break }
}
$manifest.thresholds.recovery_monotonic = $monotonic
if ($monotonic -or @($allCalculations | Where-Object { -not $_.pass }).Count -gt 0) { $manifest.pass = $false } else { $manifest.pass = $true }
$manifestPath = Join-Path $OutputDirectory "run-manifest.json"
$calculationPath = Join-Path $OutputDirectory "calculations.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
[pscustomobject]@{ schema = "phase7e-memory-calculations-v1"; pass = $manifest.pass; runs = $allCalculations } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $calculationPath -Encoding utf8
if (-not (Test-Path $manifestPath) -or -not (Test-Path $calculationPath) -or $allCalculations.Count -ne ($Expected.Count * $Runs)) { Fail "required evidence artifacts are absent or incomplete" }
if (-not $manifest.pass) { Fail "memory thresholds or recovery monotonicity failed; see calculations.json" }
Write-Output ($manifest | ConvertTo-Json -Depth 4)

param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$PresetPath,
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
if (-not [System.IO.Path]::IsPathFullyQualified($PresetPath) -or
    -not $PresetPath.EndsWith(".geoim3d-preset.json", [System.StringComparison]::Ordinal) -or
    -not (Test-Path -LiteralPath $PresetPath -PathType Leaf)) {
  throw "PHASE7E_PICKER_PATH_INVALID"
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Phase7ePickerNative {
  public delegate bool EnumProc(IntPtr handle, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr value);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr handle, StringBuilder value, int count);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr word, string value);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr word, IntPtr value);
}
"@

$dialog = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  [Phase7ePickerNative]::EnumWindows({
    param($handle, $value)
    $owner = 0
    [void][Phase7ePickerNative]::GetWindowThreadProcessId($handle, [ref]$owner)
    $class = [Text.StringBuilder]::new(64)
    [void][Phase7ePickerNative]::GetClassName($handle, $class, 64)
    if ($owner -eq $AppPid -and $class.ToString() -eq "#32770") {
      $script:dialog = $handle
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($dialog -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)
if ($dialog -eq [IntPtr]::Zero) { throw "PHASE7E_PICKER_NOT_FOUND" }

$edit = [IntPtr]::Zero
$open = [IntPtr]::Zero
[Phase7ePickerNative]::EnumChildWindows($dialog, {
  param($handle, $value)
  $class = [Text.StringBuilder]::new(64)
  [void][Phase7ePickerNative]::GetClassName($handle, $class, 64)
  $id = [Phase7ePickerNative]::GetDlgCtrlID($handle)
  if ($id -eq 1148 -and $class.ToString() -eq "Edit") { $script:edit = $handle }
  if ($id -eq 1 -and $class.ToString() -eq "Button") { $script:open = $handle }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($edit -eq [IntPtr]::Zero -or $open -eq [IntPtr]::Zero) { throw "PHASE7E_PICKER_CONTROLS_NOT_FOUND" }

[void][Phase7ePickerNative]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $PresetPath)
[void][Phase7ePickerNative]::SendMessage($open, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
[pscustomobject]@{ submitted = $true; appPid = $AppPid; pathValueLogged = $false } | ConvertTo-Json -Compress

[CmdletBinding()]
param(
    [string]$ChromeExtensionId = "",
    [string]$EdgeExtensionId = "",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Monica\Extension\MDBX2")
)

$ErrorActionPreference = "Stop"
$HostName = "com.monica_pass.mdbx2"
$WindowsHelloHostName = "com.monica_pass.windows_hello"
$BundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceExecutable = Join-Path $BundleRoot "monica-mdbx2-host.exe"
$SourceUninstaller = Join-Path $BundleRoot "uninstall-host.ps1"

function Assert-ExtensionId([string]$Value, [string]$Label) {
    if ($Value -and $Value -notmatch "^[a-p]{32}$") {
        throw "$Label must be the 32-character extension ID shown by the browser."
    }
}

Assert-ExtensionId $ChromeExtensionId "ChromeExtensionId"
Assert-ExtensionId $EdgeExtensionId "EdgeExtensionId"
if (-not $ChromeExtensionId -and -not $EdgeExtensionId) {
    throw "Provide ChromeExtensionId, EdgeExtensionId, or both."
}
if (-not (Test-Path -LiteralPath $SourceExecutable -PathType Leaf)) {
    throw "The package is missing monica-mdbx2-host.exe."
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$ExecutablePath = Join-Path $InstallRoot "monica-mdbx2-host.exe"
$ManifestPath = Join-Path $InstallRoot "$HostName.json"
$WindowsHelloManifestPath = Join-Path $InstallRoot "$WindowsHelloHostName.json"
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -LiteralPath $SourceExecutable -Destination $ExecutablePath -Force
if (Test-Path -LiteralPath $SourceUninstaller -PathType Leaf) {
    Copy-Item -LiteralPath $SourceUninstaller -Destination (Join-Path $InstallRoot "uninstall-host.ps1") -Force
}

$Origins = @($ChromeExtensionId, $EdgeExtensionId) |
    Where-Object { $_ } |
    ForEach-Object { "chrome-extension://$_/" } |
    Sort-Object -Unique
# PowerShell 5.1 ConvertTo-Json collapses a single-element array into a string, which makes
# Chromium reject the manifest as an unknown host. Build the JSON explicitly so allowed_origins
# always stays an array, even with exactly one extension origin.
function New-HostManifest([string]$Name, [string]$Description, [string]$Executable, [string[]]$AllowedOrigins) {
    $OriginLines = ($AllowedOrigins | ForEach-Object { '    "' + $_ + '"' }) -join ",`r`n"
    return @"
{
  "name": "$Name",
  "description": "$Description",
  "path": "$($Executable.Replace('\', '\\'))",
  "type": "stdio",
  "allowed_origins": [
$OriginLines
  ]
}
"@
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($ManifestPath, (New-HostManifest $HostName "Monica MDBX2 Native Host" $ExecutablePath $Origins), $Utf8NoBom)
[IO.File]::WriteAllText($WindowsHelloManifestPath, (New-HostManifest $WindowsHelloHostName "Monica Windows Hello Host" $ExecutablePath $Origins), $Utf8NoBom)

if ($ChromeExtensionId) {
    $ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    New-Item -Path $ChromeKey -Force | Out-Null
    Set-Item -Path $ChromeKey -Value $ManifestPath
    $ChromeHelloKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$WindowsHelloHostName"
    New-Item -Path $ChromeHelloKey -Force | Out-Null
    Set-Item -Path $ChromeHelloKey -Value $WindowsHelloManifestPath
}
if ($EdgeExtensionId) {
    $EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
    New-Item -Path $EdgeKey -Force | Out-Null
    Set-Item -Path $EdgeKey -Value $ManifestPath
    $EdgeHelloKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$WindowsHelloHostName"
    New-Item -Path $EdgeHelloKey -Force | Out-Null
    Set-Item -Path $EdgeHelloKey -Value $WindowsHelloManifestPath
}

Write-Host "Monica MDBX2 Native Host was installed to $InstallRoot"
Write-Host "Fully exit and reopen the browser, then check Host status on the Monica password sources page."

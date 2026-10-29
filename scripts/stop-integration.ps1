$ErrorActionPreference = 'Stop'
$testProfile = Join-Path (Split-Path -Parent $PSScriptRoot) '.test-profile'
Get-CimInstance Win32_Process -Filter "Name = 'zotero.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine.Contains('-profile') -and $_.CommandLine.Contains($testProfile)) {
        Stop-Process -Id $_.ProcessId -ErrorAction Stop
        Write-Output "Stopped isolated test process $($_.ProcessId)"
    }
}

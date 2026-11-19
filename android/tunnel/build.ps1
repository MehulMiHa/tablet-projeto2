param(
    [string]$ToolchainRoot = (Join-Path $PSScriptRoot '../../../toolchains'),
    [string]$AndroidSdk = (Join-Path $env:LOCALAPPDATA 'Android/Sdk'),
    [string]$AndroidNdk = '',
    [string]$Jdk = 'C:/Program Files/Android/Android Studio/jbr',
    [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$ToolchainRoot = [IO.Path]::GetFullPath($ToolchainRoot)
if (!$AndroidNdk) { $AndroidNdk = Join-Path $ToolchainRoot 'android-ndk-r30' }
$goBin = Join-Path $ToolchainRoot 'go/bin'
$env:GOPATH = Join-Path $ToolchainRoot 'gopath'
$env:GOCACHE = Join-Path $ToolchainRoot 'go-cache'
$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_NDK_HOME = $AndroidNdk
$env:PATH = "$goBin;$(Join-Path $env:GOPATH 'bin');$(Join-Path $Jdk 'bin');$env:PATH"
foreach ($required in @((Join-Path $goBin 'go.exe'), (Join-Path $Jdk 'bin/javac.exe'), (Join-Path $AndroidNdk 'source.properties'))) {
    if (!(Test-Path -LiteralPath $required)) { throw "Missing official build prerequisite: $required" }
}
function Invoke-Checked([scriptblock]$Action) {
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "Build command failed with exit code $LASTEXITCODE" }
}
Push-Location $PSScriptRoot
try {
    $mobileVersion = 'v0.0.0-20261117202452-47699113848a'
    Invoke-Checked { go mod download }
    Invoke-Checked { go install "golang.org/x/mobile/cmd/gomobile@$mobileVersion" }
    Invoke-Checked { go install "golang.org/x/mobile/cmd/gobind@$mobileVersion" }
    Invoke-Checked { gomobile init }
    if (!$SkipTests) { Invoke-Checked { go test ./... } }
    New-Item -ItemType Directory -Force -Path '../mobile/libs' | Out-Null
    # Match upstream build_dist.sh's supported version stamps. gomobile has no
    # useful main-module VCS build info; without stamps the admin console shows
    # ERR-BuildInfo. Keep the embedded build explicitly identified as Eddy.
    $tailscaleModule = go mod download -json tailscale.com | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or !$tailscaleModule.Version -or !$tailscaleModule.Info) { throw 'Could not determine the pinned Tailscale build version' }
    $tailscaleInfo = Get-Content -Raw -LiteralPath $tailscaleModule.Info | ConvertFrom-Json
    if ($tailscaleInfo.Origin.URL -ne 'https://github.com/tailscale/tailscale' -or $tailscaleInfo.Origin.Hash -notmatch '^[0-9a-f]{40}$') { throw 'Could not verify the pinned Tailscale source revision' }
    $tailscaleVersion = $tailscaleModule.Version.TrimStart('v')
    $linkerFlags = "-s -w -X tailscale.com/version.longStamp=$tailscaleVersion-eddy -X tailscale.com/version.shortStamp=$tailscaleVersion -X tailscale.com/version.gitCommitStamp=$($tailscaleInfo.Origin.Hash)"
    Invoke-Checked { gomobile bind -target=android/arm64 -androidapi=24 "-ldflags=$linkerFlags" -o '../mobile/libs/eddy-tunnel.aar' . }
    $aarHash = (Get-FileHash -LiteralPath '../mobile/libs/eddy-tunnel.aar' -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'eddy-tunnel.aar.sha256'), "$aarHash  eddy-tunnel.aar`n", [Text.UTF8Encoding]::new($false))

    # Distribute notices for the Go runtime and the complete pinned module graph.
    # The graph includes some platform-only dependencies; retaining their notices
    # is preferable to dropping a copyright acknowledgement from a build variant.
    $notices = [Text.StringBuilder]::new()
    [void]$notices.AppendLine("Eddy embedded private transport - third-party notices`n")
    [void]$notices.AppendLine("Go runtime`n============`n")
    [void]$notices.AppendLine((Get-Content -Raw -LiteralPath (Join-Path $ToolchainRoot 'go/LICENSE')))
    $moduleDirectories = go list -m -f '{{.Path}}|{{.Dir}}' all
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate dependency notices' }
    foreach ($module in $moduleDirectories) {
        $fields = $module.Split('|',2)
        if ($fields.Count -ne 2 -or !$fields[1]) { continue }
        foreach ($name in @('LICENSE','LICENSE.txt','LICENSE.md','COPYING','NOTICE','NOTICE.txt','COPYRIGHT')) {
            $noticePath = Join-Path $fields[1] $name
            if (Test-Path -LiteralPath $noticePath -PathType Leaf) {
                [void]$notices.AppendLine("`n$($fields[0]) - $name`n============`n")
                [void]$notices.AppendLine((Get-Content -Raw -LiteralPath $noticePath))
            }
        }
    }
    $assets = Join-Path $PSScriptRoot '../mobile/src/main/assets'
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    $noticeText = [regex]::Replace($notices.ToString(), '(?m)[\t ]+$', '').TrimEnd() + "`n"
    [IO.File]::WriteAllText((Join-Path $assets 'third-party-notices.txt'), $noticeText, [Text.UTF8Encoding]::new($false))
    Write-Output 'Built android/mobile/libs/eddy-tunnel.aar and its distribution notices.'
} finally { Pop-Location }

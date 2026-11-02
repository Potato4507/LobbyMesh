[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$verificationRoot = Split-Path -Parent $PSScriptRoot
$verificationDirectory = $null
$verificationLock = $null
$verificationLockPath = Join-Path $verificationRoot 'dist/windows-verification.lock'
$verificationStage = 'preflight'
$verificationSteps = [System.Collections.Generic.List[object]]::new()
$verificationSummary = [ordered]@{
    result = 'failed'
    stage = 'preflight'
    reason = $null
    source = $null
    steps = $verificationSteps
    package = $null
    releaseReady = $false
}
$verificationExit = 1

function Invoke-VerificationStep {
    param([string]$StepName, [string[]]$StepArguments)
    $script:verificationStage = $StepName
    $stepLog = Join-Path $script:verificationDirectory "$StepName.log"
    Write-Output (@{ windowsVerificationStage = $StepName; state = 'started' } | ConvertTo-Json -Compress)
    $stepClock = [System.Diagnostics.Stopwatch]::StartNew()
    & pnpm @StepArguments *> $stepLog
    $stepExit = $LASTEXITCODE
    $stepClock.Stop()
    $script:verificationSteps.Add([ordered]@{
        name = $StepName
        exitCode = $stepExit
        durationMs = $stepClock.ElapsedMilliseconds
        log = $stepLog
    })
    if ($stepExit -ne 0) { throw "WINDOWS_VERIFICATION_STEP_FAILED:$StepName" }
}

Push-Location $verificationRoot
try {
    if (-not $IsWindows) { throw 'WINDOWS_VERIFICATION_WINDOWS_REQUIRED' }
    $gitRoot = & git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($verificationRoot)) {
        throw 'WINDOWS_VERIFICATION_REPOSITORY_REQUIRED'
    }
    $dirtySource = @(& git status --porcelain 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_VERIFICATION_GIT_UNAVAILABLE' }
    if ($dirtySource.Count -ne 0) { throw 'WINDOWS_VERIFICATION_DIRTY_SOURCE' }
    $sourceRevision = & git rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or $sourceRevision -notmatch '^[a-f0-9]{40}$') {
        throw 'WINDOWS_VERIFICATION_REVISION_UNAVAILABLE'
    }
    $verificationSummary.source = @{ revision = $sourceRevision; dirty = $false }
    New-Item -ItemType Directory -Path (Join-Path $verificationRoot 'dist') -Force | Out-Null
    try {
        $verificationLock = [IO.File]::Open($verificationLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch { throw 'WINDOWS_VERIFICATION_BUSY' }
    $verificationDirectory = Join-Path $verificationRoot ('dist/windows-verification-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $verificationDirectory | Out-Null
    Invoke-VerificationStep 'typecheck' @('typecheck')
    Invoke-VerificationStep 'lint' @('lint')
    Invoke-VerificationStep 'tests' @('test')
    Invoke-VerificationStep 'build' @('build')
    Invoke-VerificationStep 'desktop' @('test:desktop')
    Invoke-VerificationStep 'identity-ui' @('test:identity')
    Invoke-VerificationStep 'send-recovery' @('test:send-recovery')
    Invoke-VerificationStep 'voice-calls' @('test:voice-calls')
    Invoke-VerificationStep 'independent-voice' @('test:independent-voice')
    Invoke-VerificationStep 'package' @('package:win')
    $verificationStage = 'package-integrity'
    $packagePointer = Get-Content -LiteralPath (Join-Path $verificationRoot 'dist/windows-development-latest.json') -Raw | ConvertFrom-Json
    $packageManifest = Get-Content -LiteralPath $packagePointer.manifest -Raw | ConvertFrom-Json
    if ($packageManifest.git.revision -ne $sourceRevision -or $packageManifest.git.dirty -ne $false) {
        throw 'WINDOWS_VERIFICATION_PACKAGE_SOURCE_MISMATCH'
    }
    $manifestDigest = (Get-FileHash -LiteralPath $packagePointer.manifest -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-VerificationStep 'package-integrity' @('verify:package', $packagePointer.directory, '--manifest-sha256', $manifestDigest)
    $verificationSummary.package = [ordered]@{
        directory = $packagePointer.directory
        executable = $packagePointer.executable
        manifestSha256 = $manifestDigest
        signature = (Get-AuthenticodeSignature -LiteralPath $packagePointer.executable).Status.ToString()
        smoke = $packageManifest.smoke
    }
    $verificationStage = 'source-check'
    $finalRevision = & git rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or $finalRevision -ne $sourceRevision) { throw 'WINDOWS_VERIFICATION_SOURCE_CHANGED' }
    $finalDirty = @(& git status --porcelain 2>$null)
    if ($LASTEXITCODE -ne 0 -or $finalDirty.Count -ne 0) { throw 'WINDOWS_VERIFICATION_SOURCE_CHANGED' }
    $verificationSummary.result = 'passed'
    $verificationStage = 'complete'
    $verificationExit = 0
} catch {
    $failureCode = $_.Exception.Message
    if ($failureCode -notmatch '^WINDOWS_VERIFICATION_[A-Z_]+(?::[a-z-]+)?$') {
        $failureCode = 'WINDOWS_VERIFICATION_FAILED'
    }
    $verificationSummary.reason = $failureCode
} finally {
    try {
        $verificationSummary.stage = $verificationStage
        if ($verificationDirectory) {
            $summaryPath = Join-Path $verificationDirectory 'summary.json'
            $verificationSummary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding utf8
            Write-Output (@{ windowsVerificationSummary = $summaryPath; result = $verificationSummary.result; stage = $verificationStage; reason = $verificationSummary.reason } | ConvertTo-Json -Compress)
        } else {
            Write-Output ($verificationSummary | ConvertTo-Json -Depth 12 -Compress)
        }
    } finally {
        if ($verificationLock) {
            $verificationLock.Dispose()
            Remove-Item -LiteralPath $verificationLockPath
        }
        Pop-Location
    }
}
exit $verificationExit

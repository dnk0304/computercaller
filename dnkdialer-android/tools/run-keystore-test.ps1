# E2E P4 (s3) — real process-death proof for E2eKeyStore.
#
# A test cannot outlive the process it asserts about, so the survival check is
# two instrumentation runs with an `am force-stop` in between. Running the test
# class in one go proves only persistence across a fresh KeyStore load; this
# script is what makes it a process-death proof.
#
# Usage:  pwsh tools/run-keystore-test.ps1
# Needs:  a connected device/emulator and ANDROID_HOME.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$pkg = 'com.dnkdialer.companion'
$runner = "$pkg.test/androidx.test.runner.AndroidJUnitRunner"
$cls = "$pkg.E2eKeyStoreTest"

Write-Host '== installing app + test APKs =='
& .\gradlew.bat :app:installDebug :app:installDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "install failed ($LASTEXITCODE)" }

function Invoke-Phase([string]$method) {
    Write-Host "== force-stop, then run $method =="
    & $adb shell am force-stop $pkg | Out-Null
    & $adb shell am force-stop "$pkg.test" | Out-Null
    $out = (& $adb shell am instrument -w -e class "$cls#$method" $runner) -join "`n"
    Write-Host $out
    # Two traps here, both hit during (s3):
    #  1. `am instrument` exits 0 even when tests FAIL — the report text is the
    #     only signal, so assert on it explicitly.
    #  2. `-match` / `-notmatch` against a STRING ARRAY is a filter, not a
    #     boolean: `$array -notmatch 'OK'` returns every non-matching line and
    #     is therefore truthy even on a passing run. Hence the -join above.
    if ($out -match 'FAILURES!!!' -or $out -match 'INSTRUMENTATION_STATUS: stack=') {
        throw "$method FAILED"
    }
    if ($out -notmatch 'OK \(') { throw "$method did not report OK" }
}

# Phase 1 generates the key and writes its public bytes to filesDir.
Invoke-Phase 'phase1_generateAndRecordPublicKey'
# The force-stop inside phase 2's invocation is the process death being proved.
Invoke-Phase 'phase2_keySurvivesProcessDeath'

Write-Host '== remaining in-process tests =='
& $adb shell am force-stop $pkg | Out-Null
$out = (& $adb shell am instrument -w -e class $cls `
    -e notClass "$cls#phase1_generateAndRecordPublicKey,$cls#phase2_keySurvivesProcessDeath" `
    $runner) -join "`n"
Write-Host $out
if ($out -match 'FAILURES!!!') { throw 'in-process tests FAILED' }
if ($out -notmatch 'OK \(') { throw 'in-process tests did not report OK' }

Write-Host 'PROCESS-DEATH PROOF: PASS'

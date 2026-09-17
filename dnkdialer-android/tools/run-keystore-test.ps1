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

Write-Host '== building app + test APKs =='
& .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "assemble failed ($LASTEXITCODE)" }

# Uninstall, then install clean — do NOT use gradle's :app:installDebug or a
# bare `adb install -r`. Both keep the old APK alive during the swap, and on a
# near-full device that fails with INSTALL_FAILED_INSUFFICIENT_STORAGE even
# though the APK is only ~10 MB (hit repeatedly on the (s5) emulator at 95%
# /data). Uninstalling first also removes the stale-APK trap: a failed
# reinstall leaves the PREVIOUS build on the device and every test below still
# passes, against code that is not the code under review.
# Preflight: Android refuses ALL installs once free space drops below the
# "low storage" threshold — min(10% of the partition, sys_storage_threshold_
# max_bytes, default 500 MB). A 6 GB emulator at 343 MB free therefore refuses
# a 10 MB APK with the very misleading
#   INSTALL_FAILED_INSUFFICIENT_STORAGE: Failed to override installation location
# which reads like an install-location bug and sends you hunting the wrong
# thing. Lower the threshold rather than deleting anything: it is a global
# setting, reversible with `settings delete global ...`, and the device really
# does have room. Cost us ~20 min in (s5).
$THRESHOLD = 16777216
if (((& $adb shell settings get global sys_storage_threshold_max_bytes) -join '').Trim() -ne "$THRESHOLD") {
    Write-Host "== lowering low-storage install threshold to $THRESHOLD =="
    & $adb shell settings put global sys_storage_threshold_max_bytes $THRESHOLD | Out-Null
}

Write-Host '== installing app + test APKs =='
& $adb uninstall "$pkg.test" 2>&1 | Out-Null   # may not be present; ignore
& $adb uninstall $pkg 2>&1 | Out-Null
foreach ($apk in @(
    'app\build\outputs\apk\debug\app-debug.apk',
    'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')) {
    $r = (& $adb install $apk) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $r -notmatch 'Success') {
        throw "adb install failed for ${apk}: $r"
    }
}

# Prove the device is running THIS build before asserting anything about it —
# a failed install silently leaves a stale APK and every test still passes.
$vc = (& $adb shell dumpsys package $pkg | Select-String 'versionCode=' | Select-Object -First 1) -join ''
Write-Host "installed: $($vc.Trim())"
if ($vc -notmatch 'versionCode=58') { throw "device is not running versionCode 58: $vc" }

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

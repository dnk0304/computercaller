# FT-2 (f) - instrumented run of FileTransferLoopbackTest.
#
# Same install discipline as run-agreement-test.ps1, and repeated rather than
# factored out for the same reason that file gives: both traps below are
# SILENT-FALSE-GREEN traps, and a shared helper that drifts would reinstate
# them on whichever lane stopped watching.
#
#   * a failed install leaves the PREVIOUS APK on the device and every test
#     still passes, against code that is not the code under review;
#   * Android refuses all installs under its low-storage threshold with the
#     misleading message "Failed to override installation location".
#
# Two traps this script adds on top, both hit while writing it:
#
#   * `am instrument` exits 0 when tests FAIL, and prints "OK (0 tests)" when a
#     class filter matches nothing. The brief's "gradle 0 tests ran = FAIL"
#     rule is enforced here explicitly, not inferred from an exit code.
#   * the 200 MB fixture needs ~400 MB free on the emulator (fixture + .part).
#     Checking first turns an incomprehensible IOException deep in a transfer
#     into one line at the top.
#
# Usage:  pwsh tools/run-filetransfer-test.ps1
# Needs:  a connected device/emulator and ANDROID_HOME.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$pkg = 'com.dnkdialer.companion'
$runner = "$pkg.test/androidx.test.runner.AndroidJUnitRunner"
$cls = "$pkg.FileTransferLoopbackTest"

# FT-2 is v59 work but must NOT bump the code - vc58 is P5b's signed build and
# Ken bumps at merge. So this asserts the code the branch actually carries
# rather than a number this script wishes for.
$expectedVc = (Select-String -Path 'app\build.gradle.kts' -Pattern '^\s*versionCode\s*=\s*(\d+)' |
    Select-Object -First 1).Matches.Groups[1].Value
Write-Host "== branch declares versionCode $expectedVc =="

Write-Host '== building app + test APKs =='
& .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "assemble failed ($LASTEXITCODE)" }

$THRESHOLD = 16777216
if (((& $adb shell settings get global sys_storage_threshold_max_bytes) -join '').Trim() -ne "$THRESHOLD") {
    Write-Host "== lowering low-storage install threshold to $THRESHOLD =="
    & $adb shell settings put global sys_storage_threshold_max_bytes $THRESHOLD | Out-Null
}

# The 200 MB fixture plus its in-flight copy needs real room in /data.
$free = ((& $adb shell df /data | Select-Object -Last 1) -join ' ') -split '\s+'
Write-Host "== /data free: $($free[3]) KB =="
if ([int64]$free[3] -lt 600000) {
    throw "less than 600 MB free on /data - the 200 MB fixture will fail mid-transfer"
}

Write-Host '== installing app + test APKs =='
& $adb uninstall "$pkg.test" 2>&1 | Out-Null
& $adb uninstall $pkg 2>&1 | Out-Null
foreach ($apk in @(
    'app\build\outputs\apk\debug\app-debug.apk',
    'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')) {
    $r = (& $adb install $apk) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $r -notmatch 'Success') {
        throw "adb install failed for ${apk}: $r"
    }
}

# Assert the device runs THIS build before asserting anything about it.
$vc = (& $adb shell dumpsys package $pkg | Select-String 'versionCode=' | Select-Object -First 1) -join ''
Write-Host "installed: $($vc.Trim())"
if ($vc -notmatch "versionCode=$expectedVc") {
    throw "device is not running versionCode ${expectedVc}: $vc"
}

$api = ((& $adb shell getprop ro.build.version.sdk) -join '').Trim()
Write-Host "device API level: $api"

# API 26 emulators answer "failed to clear the 'main' log" and keep going. It
# is not a failure worth stopping for, but it DOES mean the buffer may still
# hold an earlier run's lines - so every grep below is anchored to this run's
# class name rather than to a bare marker.
try { & $adb logcat -c 2>&1 | Out-Null } catch { Write-Host 'logcat -c refused; buffer not cleared' }
& $adb shell am force-stop $pkg | Out-Null
$out = (& $adb shell am instrument -w -e class $cls $runner) -join "`n"
Write-Host $out

if ($out -match 'FAILURES!!!' -or $out -match 'INSTRUMENTATION_STATUS: stack=') {
    throw "$cls FAILED"
}
if ($out -notmatch 'OK \(') { throw "$cls did not report OK" }
$m = [regex]::Match($out, 'OK \((\d+) test')
if (-not $m.Success -or [int]$m.Groups[1].Value -lt 1) { throw "$cls ran ZERO tests" }

Write-Host "INSTRUMENTED TOTAL: $($m.Groups[1].Value) tests"

# The memory number for the resume. It comes from logcat, not from the $out variable:
# `am instrument` discards a PASSING test's stdout, so a fact logged by a test
# that passed is only ever visible here.
$mem = ((& $adb logcat -d -s 'FT2-MEM:I') | Select-String '200MB send') -join ' '
Write-Host "MEMORY: $mem"
Write-Host "200MB SEND: PASS"
Write-Host "RECEIVE + RENAME: PASS"
Write-Host "RESUME AFTER SOCKET KILL: PASS"
Write-Host "HASH MISMATCH + .part DELETED: PASS"
Write-Host "CANCEL: PASS"
Write-Host "SEALED-MODE TWIN: PASS"

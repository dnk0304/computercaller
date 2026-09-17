# E2E P4 Part 2 (a2)+(b) — instrumented run of the crypto suite:
#   E2eKeyAgreementTest   — P-256 ECDH on both backends
#   E2eSasVectorsTest     — the frozen SAS against P1's tests/sas-vectors.json
#
# Both classes run off ONE install because the install is the slow part and
# because a second install between them would reintroduce the stale-APK trap.
#
# Separate from run-keystore-test.ps1 because that script's shape is a
# two-phase process-death proof and this one is not: key agreement is proven in
# a single process. What IS shared is the install discipline, and it is repeated
# here rather than factored out because both traps below are silent-false-green
# traps, and a shared helper that drifts would reinstate them:
#
#   * a failed install leaves the PREVIOUS APK on the device and every test
#     still passes, against code that is not the code under review;
#   * Android refuses all installs under its low-storage threshold with the
#     misleading message "Failed to override installation location".
#
# Usage:  pwsh tools/run-agreement-test.ps1
# Needs:  a connected device/emulator and ANDROID_HOME.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$pkg = 'com.dnkdialer.companion'
$runner = "$pkg.test/androidx.test.runner.AndroidJUnitRunner"
$classes = @(
    "$pkg.E2eKeyAgreementTest",   # P-256 ECDH on both backends
    "$pkg.E2eSasVectorsTest",     # the frozen SAS vs P1's tests/sas-vectors.json
    "$pkg.E2eSeqStoreTest",       # A1 acceptance: persist-before-emit / restore fails closed
    "$pkg.E2eSessionTest",        # A1 item 2: directional separation, dedupe, re-pair
    "$pkg.E2eAcceptTest"          # (d) the Accept handshake, multi-recipient
)

Write-Host '== building app + test APKs =='
& .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "assemble failed ($LASTEXITCODE)" }

$THRESHOLD = 16777216
if (((& $adb shell settings get global sys_storage_threshold_max_bytes) -join '').Trim() -ne "$THRESHOLD") {
    Write-Host "== lowering low-storage install threshold to $THRESHOLD =="
    & $adb shell settings put global sys_storage_threshold_max_bytes $THRESHOLD | Out-Null
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
if ($vc -notmatch 'versionCode=58') { throw "device is not running versionCode 58: $vc" }

$api = ((& $adb shell getprop ro.build.version.sdk) -join '').Trim()
Write-Host "device API level: $api"

& $adb logcat -c | Out-Null
$total = 0
foreach ($cls in $classes) {
    & $adb shell am force-stop $pkg | Out-Null
    $out = (& $adb shell am instrument -w -e class $cls $runner) -join "`n"
    Write-Host $out

    # `am instrument` exits 0 even when tests FAIL, and `-notmatch` on a STRING
    # ARRAY is a filter rather than a boolean — hence the -join and the explicit
    # text assertions. Both cost real time in (s3).
    if ($out -match 'FAILURES!!!' -or $out -match 'INSTRUMENTATION_STATUS: stack=') {
        throw "$cls FAILED"
    }
    if ($out -notmatch 'OK \(') { throw "$cls did not report OK" }

    # Assert the run was not EMPTY. `am instrument` prints "OK (0 tests)" and
    # exits 0 when a class filter matches nothing — a typo in a class name would
    # otherwise read as a clean pass.
    $m = [regex]::Match($out, 'OK \((\d+) test')
    if (-not $m.Success -or [int]$m.Groups[1].Value -lt 1) { throw "$cls ran ZERO tests" }
    $total += [int]$m.Groups[1].Value
    Write-Host "$cls : $($m.Groups[1].Value) tests OK"
}
Write-Host "INSTRUMENTED TOTAL: $total tests"

# Surface the measured platform facts for the gate JSON / commit message.
# They come from logcat, not $out: `am instrument` discards a PASSING test's
# stdout, so the facts are only ever visible on the runs we do not want.
$fact = ((& $adb logcat -d -s 'E2E-FACT:I') | Select-String 'api=') -join ' '
Write-Host "KEYSTORE FACTS: $fact"
Write-Host "KEY AGREEMENT: PASS (API $api)"
Write-Host "SAS VECTORS: PASS"
Write-Host "COUNTER FAIL-CLOSED: PASS"
Write-Host "SESSION: PASS"
Write-Host "ACCEPT: PASS"

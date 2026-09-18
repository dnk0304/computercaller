# E2E P4.1 (b) — real process-death proof for the Encrypted-mode toggle's
# capability provider.
#
# A test cannot outlive the process it asserts about, so the survival check is
# two instrumentation runs with an `am force-stop` in between: phase 1
# advertises a capable computer, the process dies, phase 2 asks
# E2ePeerCapability.current() the same question SettingsActivity asks and must
# get PEER_SUPPORTED. Running the class in one go proves only that a
# SharedPreferences read works — this script is what makes it a process-death
# proof, exactly as run-keystore-test.ps1 is for E2eKeyStore.
#
# Assumes the APKs are already installed by an earlier step of the same gate
# run (run-keystore-test.ps1 does the uninstall/install/version assertion).
# It re-asserts the installed versionCode anyway: a step that runs against a
# stale APK passes while testing code that is not the code under review.
#
# Usage:  pwsh tools/run-peer-capability-test.ps1
# Needs:  a connected device/emulator and ANDROID_HOME.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'

# ---------------------------------------------------------------- serial pin
# Rule 15 / R-AA: this box runs more than one emulator and every lane starts
# its own. A bare `adb` call then fails with "more than one device/emulator"
# and the gate reads that as the PRODUCT failing. ANDROID_SERIAL wins; a single
# attached device is unambiguous; anything else is a hard stop that NAMES the
# candidates rather than running this lane's tests on another lane's emulator.
$serial = $env:ANDROID_SERIAL
if (-not $serial) {
    $devices = @(& $adb devices | Select-String -Pattern '^(\S+)\s+device$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value })
    if ($devices.Count -eq 1) {
        $serial = $devices[0]
    } elseif ($devices.Count -eq 0) {
        throw "no device/emulator attached"
    } else {
        throw "more than one device attached ($($devices -join ', ')) and ANDROID_SERIAL is not set - refusing to guess which one is this lane's"
    }
}
Write-Host "device: $serial"
# Prove the device answers before asserting anything about what it runs.
$probe = ((& $adb -s $serial shell getprop ro.build.version.sdk) -join '').Trim()
if ($probe -notmatch '^\d+$') { throw "device $serial did not answer getprop (got '$probe')" }

$pkg = 'com.dnkdialer.companion'
$runner = "$pkg.test/androidx.test.runner.AndroidJUnitRunner"
$cls = "$pkg.E2ePeerCapabilityProcessDeathTest"

Write-Host '== building app + test APKs =='
& .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "assemble failed ($LASTEXITCODE)" }

# Install if absent, and assert what is actually on the device either way. A
# missing install here would otherwise surface as "0 tests ran" three steps
# later, which reads like a class-name typo.
$installed = (& $adb -s $serial shell pm list packages $pkg) -join ''
if ($installed -notmatch [regex]::Escape($pkg)) {
    foreach ($apk in @(
        'app\build\outputs\apk\debug\app-debug.apk',
        'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')) {
        $r = (& $adb -s $serial install $apk) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $r -notmatch 'Success') { throw "adb install failed for ${apk}: $r" }
    }
}
$vc = (& $adb -s $serial shell dumpsys package $pkg | Select-String 'versionCode=' | Select-Object -First 1) -join ''
Write-Host "installed: $($vc.Trim())"
if ($vc -notmatch 'versionCode=58') { throw "device is not running versionCode 58: $vc" }

$total = 0

function Invoke-Phase([string]$method) {
    Write-Host "== force-stop, then run $method =="
    & $adb -s $serial shell am force-stop $pkg | Out-Null
    & $adb -s $serial shell am force-stop "$pkg.test" | Out-Null
    $out = (& $adb -s $serial shell am instrument -w -e class "$cls#$method" $runner) -join "`n"
    Write-Host $out
    # Three traps, all of them previously paid for on this lane:
    #  1. `am instrument` exits 0 even when tests FAIL — the report text is the
    #     only signal, so assert on it explicitly.
    #  2. `-match` against a STRING ARRAY is a filter, not a boolean; hence the
    #     -join above.
    #  3. "OK (0 tests)" also exits 0, so a typo in the class or method name
    #     reads as a clean pass. Gradle "0 tests ran" = FAIL, and so is this.
    if ($out -match 'FAILURES!!!' -or $out -match 'INSTRUMENTATION_STATUS: stack=') {
        throw "$method FAILED"
    }
    $m = [regex]::Match($out, 'OK \((\d+) test')
    if (-not $m.Success -or [int]$m.Groups[1].Value -lt 1) { throw "$method ran ZERO tests" }
    # An Assume that skipped the whole method is not a pass either: it would
    # mean the device cannot hold an E2E key, and this proof would be vacuous.
    if ($out -match 'AssumptionViolatedException') { throw "$method was SKIPPED by an assumption - the proof did not run" }
    $script:total += [int]$m.Groups[1].Value
}

# Phase 1 persists the advertisement. Phase 2's own force-stop is the process
# death being proved.
Invoke-Phase 'phase1_advertiseFromACapableComputer'
Invoke-Phase 'phase2_settingsReadsPeerSupportedAfterProcessDeath'

Write-Host '== remaining in-process tests =='
& $adb -s $serial shell am force-stop $pkg | Out-Null
$out = (& $adb -s $serial shell am instrument -w -e class $cls `
    -e notClass "$cls#phase1_advertiseFromACapableComputer,$cls#phase2_settingsReadsPeerSupportedAfterProcessDeath" `
    $runner) -join "`n"
Write-Host $out
if ($out -match 'FAILURES!!!') { throw 'in-process tests FAILED' }
$m = [regex]::Match($out, 'OK \((\d+) test')
if (-not $m.Success -or [int]$m.Groups[1].Value -lt 1) { throw 'in-process tests ran ZERO tests' }
$total += [int]$m.Groups[1].Value

# Leave the device in the state the UI suite expects: no stored advertisement.
# zz_leaveNoRecordBehind does this in-process, but a crash mid-suite would not,
# and the UI suite asserts the UNPAIRED row.
& $adb -s $serial shell am force-stop $pkg | Out-Null

Write-Host "PEER CAPABILITY TOTAL: $total tests"
Write-Host 'PEER CAPABILITY PROCESS-DEATH PROOF: PASS'

# E2E P5b (b)-(d) — instrumented run of the Encrypted-mode UI suite.
#
# Same install discipline as run-agreement-test.ps1 (a failed install leaves
# the PREVIOUS APK on the device and every test passes against code that is
# not the code under review; Android refuses installs under its low-storage
# threshold with a misleading message), repeated rather than factored out for
# the reason that script gives: both are silent-false-green traps and a shared
# helper that drifts would reinstate them.
#
# What this script adds over the crypto runner is DEVICE STATE. The UI suite
# drives MainActivity, and MainActivity is only itself when three things are
# true. Each of these cost a debugging cycle in (c), so each is asserted here
# rather than left to whatever the emulator happened to be:
#
#   1. RUNTIME PERMISSIONS GRANTED. MainActivity renders a blocking
#      permissions pane instead of activity_main when any runtime permission
#      is missing, so every findViewById on the hero card returns null. CAMERA
#      is in that list and is easy to miss.
#
#   2. BATTERY-OPTIMIZATION EXEMPTION ALREADY HELD. This is the subtle one.
#      Without it MainActivity fires the system "allow background activity"
#      dialog on resume; that dialog PAUSES MainActivity, onPause
#      UNREGISTERS the pairing/SAS broadcast receiver, and every broadcast the
#      suite sends is then delivered to nobody. The symptom is a SAS face that
#      never appears with no error anywhere — it reads exactly like a missing
#      receiver registration, and it is not one.
#
#   3. A SIGNED-IN LOOK. Handled per-test by seeding TokenStore, not here.
#
# Usage:  pwsh tools/run-ui-tests.ps1
# Needs:  a connected device/emulator and ANDROID_HOME.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$pkg = 'com.dnkdialer.companion'
$runner = "$pkg.test/androidx.test.runner.AndroidJUnitRunner"
$classes = @(
    "$pkg.E2eSettingsToggleUiTest",   # (b) the Encrypted mode toggle
    "$pkg.E2eSasConfirmUiTest",       # (c) the SAS confirm, via the real contract
    "$pkg.E2eKeyChangeUiTest",        # (d) the TOFU warning + Encrypted status
    "$pkg.SettingsScreenshotHelper",  # P4 (s5) regression: the row is still honest
    "$pkg.E2eP5bScreenshots"          # evidence, both themes
)

# Runtime permissions MainActivity blocks on. CAMERA included deliberately.
$permissions = @(
    'READ_SMS', 'SEND_SMS', 'RECEIVE_SMS', 'RECEIVE_MMS',
    'READ_CALL_LOG', 'READ_PHONE_STATE', 'READ_PHONE_NUMBERS',
    'READ_CONTACTS', 'CALL_PHONE', 'ANSWER_PHONE_CALLS',
    'POST_NOTIFICATIONS', 'CAMERA'
)

# ---------------------------------------------------------------- serial pin
# This box runs more than one emulator: other E2E lanes are told to start their
# own (FT-2's e2e_api26 on 5556 collided with this lane's Medium_Phone on 5554
# mid-gate). Every bare `adb` call then fails with "more than one
# device/emulator", and the gate reads that as the PRODUCT failing rather than
# as two lanes sharing a host.
#
# So every adb call below is pinned with -s. The serial comes from
# ANDROID_SERIAL when set (the caller knows which device is its own); a single
# attached device is taken as unambiguous; anything else is a hard stop that
# NAMES the candidates, because picking one by position would silently run this
# lane's tests on another lane's emulator.
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

Write-Host '== building app + test APKs =='
& .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q
if ($LASTEXITCODE -ne 0) { throw "assemble failed ($LASTEXITCODE)" }

$THRESHOLD = 16777216
if (((& $adb -s $serial shell settings get global sys_storage_threshold_max_bytes) -join '').Trim() -ne "$THRESHOLD") {
    Write-Host "== lowering low-storage install threshold to $THRESHOLD =="
    & $adb -s $serial shell settings put global sys_storage_threshold_max_bytes $THRESHOLD | Out-Null
}

Write-Host '== installing app + test APKs =='
& $adb -s $serial uninstall "$pkg.test" 2>&1 | Out-Null
& $adb -s $serial uninstall $pkg 2>&1 | Out-Null
foreach ($apk in @(
    'app\build\outputs\apk\debug\app-debug.apk',
    'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')) {
    $r = (& $adb -s $serial install $apk) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $r -notmatch 'Success') {
        throw "adb install failed for ${apk}: $r"
    }
}

# Assert the device runs THIS build before asserting anything about it.
$vc = (& $adb -s $serial shell dumpsys package $pkg | Select-String 'versionCode=' | Select-Object -First 1) -join ''
Write-Host "installed: $($vc.Trim())"
if ($vc -notmatch 'versionCode=58') { throw "device is not running versionCode 58: $vc" }

Write-Host '== device state: runtime permissions =='
foreach ($p in $permissions) {
    & $adb -s $serial shell pm grant $pkg "android.permission.$p" 2>&1 | Out-Null
}
# Prove it, rather than trusting that `pm grant` had anything to say. A silently
# ungranted permission puts the blocking pane on screen and every hero-card
# lookup returns null.
$denied = (& $adb -s $serial shell dumpsys package $pkg | Select-String 'granted=false') -join "`n"
if ($denied -match 'android.permission.CAMERA') {
    throw "CAMERA is still denied: MainActivity will render the permissions pane, not the hero card"
}

Write-Host '== device state: battery-optimization exemption =='
& $adb -s $serial shell dumpsys deviceidle whitelist "+$pkg" | Out-Null
$wl = (& $adb -s $serial shell dumpsys deviceidle whitelist) -join "`n"
if ($wl -notmatch [regex]::Escape($pkg)) {
    throw "$pkg is not battery-whitelisted: MainActivity will raise the exemption dialog, which pauses it, which unregisters the SAS receiver, and every broadcast goes nowhere"
}

& $adb -s $serial logcat -c | Out-Null
$total = 0
foreach ($cls in $classes) {
    & $adb -s $serial shell am force-stop $pkg | Out-Null
    $out = (& $adb -s $serial shell am instrument -w -e class $cls $runner) -join "`n"
    Write-Host $out

    # `am instrument` exits 0 even when tests FAIL, and `-notmatch` on a STRING
    # ARRAY is a filter rather than a boolean — hence the -join and the
    # explicit text assertions.
    if ($out -match 'FAILURES!!!' -or $out -match 'INSTRUMENTATION_STATUS: stack=') {
        throw "$cls FAILED"
    }
    if ($out -notmatch 'OK \(') { throw "$cls did not report OK" }

    # Assert the run was not EMPTY. `am instrument` prints "OK (0 tests)" and
    # exits 0 when a class filter matches nothing, so a typo in a class name
    # would otherwise read as a clean pass. Gradle "0 tests ran" = FAIL.
    $m = [regex]::Match($out, 'OK \((\d+) test')
    if (-not $m.Success -or [int]$m.Groups[1].Value -lt 1) { throw "$cls ran ZERO tests" }
    $total += [int]$m.Groups[1].Value
    Write-Host "$cls : $($m.Groups[1].Value) tests OK"
}
Write-Host "UI INSTRUMENTED TOTAL: $total tests"

Write-Host '== pulling screenshots =='
$dest = 'docs\screenshots'
New-Item -ItemType Directory -Force $dest | Out-Null
$remote = "/sdcard/Android/data/$pkg/files/screenshots"
foreach ($line in (& $adb -s $serial shell ls $remote 2>$null)) {
    $name = $line.Trim()
    if ($name -like 'p5b-*.png') {
        & $adb -s $serial pull "$remote/$name" (Join-Path $dest $name) | Out-Null
        Write-Host "pulled $name"
    }
}

Write-Host "ENCRYPTED MODE UI: PASS"

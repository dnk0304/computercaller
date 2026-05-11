# ✅ Build Checklist

Use this checklist to build and deploy the DNK Dialer Android app.

---

## 📋 Pre-Build Checklist

### Prerequisites
- [ ] Android Studio installed (Arctic Fox or newer)
- [ ] Android phone with USB debugging enabled
- [ ] USB cable to connect phone to PC
- [ ] Phone and PC on same Wi-Fi network

---

## 🔧 Build Process

### Step 1: Open Project in Android Studio
- [ ] Launch Android Studio
- [ ] Click **"Open"** or **File → Open**
- [ ] Navigate to: `C:\Users\D\Desktop\dnkdialerandroid`
- [ ] Click **OK**
- [ ] Wait for Gradle sync to complete (2-5 minutes)

### Step 2: Resolve Any Issues
- [ ] If Gradle sync fails, click **"Sync Now"** or **File → Sync Project with Gradle Files**
- [ ] If SDK is missing, click **"Install missing SDK"** in error message
- [ ] Wait for all downloads to complete

### Step 3: Connect Device
- [ ] Connect Android phone via USB
- [ ] On phone: Tap "Allow USB debugging" prompt
- [ ] In Android Studio: Verify device appears in device dropdown (top toolbar)
- [ ] Device should show as "Online" (green dot)

### Step 4: Build and Run
- [ ] Click the green **Run** button (▶️) in toolbar
- [ ] Or press **Shift+F10**
- [ ] Select your device from the list
- [ ] Click **OK**
- [ ] Wait for build to complete (30 seconds - 2 minutes)

### Step 5: Grant Permissions
When app launches on phone:
- [ ] Tap **Allow** for Phone permission
- [ ] Tap **Allow** for SMS permission
- [ ] Tap **Allow** for Contacts permission
- [ ] Tap **Allow** for Call Log permission

### Step 6: Verify Installation
- [ ] App should show "DNK Dialer Companion" screen
- [ ] Status should show "Status: Active"
- [ ] WebSocket server should show "Port: 8765"

---

## 🔌 Connection Setup

### Step 1: Get Phone IP Address
On your Android phone:
- [ ] Open **Settings**
- [ ] Go to **Network & Internet** → **Wi-Fi**
- [ ] Tap on connected network name
- [ ] Note the **IP Address** (e.g., 192.168.1.100)
- [ ] Write it down: `___.___.___.___`

### Step 2: Start Bridge
On your PC:
- [ ] Open folder: `C:\Users\D\Desktop\dnkdialer-bridge`
- [ ] Run the bridge application
- [ ] Verify it says "Bridge server starting on port 8766..."

### Step 3: Start Web App
On your PC:
- [ ] Open folder: `C:\Users\D\Desktop\dnkdialer`
- [ ] Open terminal/command prompt in this folder
- [ ] Run: `npm run dev`
- [ ] Open browser: `http://localhost:3000`

### Step 4: Connect
In the web app:
- [ ] Enter phone IP address in connection field
- [ ] Click **Connect**
- [ ] Wait for connection status to show **"Connected"** ✅
- [ ] In bridge, verify it shows "Phone connected"

---

## 🧪 Testing

### Test 1: Basic Call
- [ ] In web dialer, type a test number (e.g., your own number)
- [ ] Click the green **Call** button
- [ ] **Expected:** Phone app opens immediately (no chooser dialog)
- [ ] **Expected:** Call starts dialing
- [ ] ✅ **Success:** No app chooser appeared

### Test 2: Call with Country Code
- [ ] Type a number with +1 prefix (e.g., +1234567890)
- [ ] Click **Call**
- [ ] **Expected:** Number is handled correctly
- [ ] ✅ **Success:** Call starts with country code

### Test 3: Multiple Calls
- [ ] Make 3 calls in a row
- [ ] Each call should go directly to phone app
- [ ] ✅ **Success:** No chooser on any call

### Test 4: Check Logs (Optional)
In Android Studio:
- [ ] Open **Logcat** (bottom panel)
- [ ] Filter by: `DNKDialer`
- [ ] Look for: `"Using default dialer: com.google.android.dialer"`
- [ ] Look for: `"Call initiated to: [number]"`
- [ ] ✅ **Success:** Logs show default dialer being used

---

## 🚨 Troubleshooting

### Issue: Gradle Sync Failed
**Fix:**
- [ ] Check internet connection
- [ ] File → Invalidate Caches / Restart
- [ ] Try again

### Issue: Device Not Showing
**Fix:**
- [ ] Check USB cable is connected properly
- [ ] On phone: Settings → Developer Options → USB Debugging (toggle off/on)
- [ ] Disconnect and reconnect USB cable
- [ ] Try different USB port

### Issue: App Chooser Still Appears
**Fix:**
- [ ] On phone: Settings → Apps → Default Apps → Phone App
- [ ] Select your preferred phone app (e.g., "Phone" or "Google Phone")
- [ ] Click "Always"
- [ ] Try calling again from web dialer

### Issue: Permission Denied
**Fix:**
- [ ] Uninstall app from phone
- [ ] Rebuild and install from Android Studio
- [ ] Grant all permissions when prompted
- [ ] Or: Settings → Apps → DNK Dialer → Permissions → Enable all

### Issue: Cannot Connect from Web App
**Fix:**
- [ ] Verify phone and PC are on **same Wi-Fi network**
- [ ] Check phone IP address is correct
- [ ] Try pinging phone from PC: `ping [phone-ip]`
- [ ] Disable Windows Firewall temporarily to test
- [ ] Ensure Android app is running on phone
- [ ] Check Logcat for WebSocket errors

### Issue: WebSocket Error
**Fix:**
- [ ] Force close app on phone
- [ ] Reopen app
- [ ] Wait for "Status: Active" to appear
- [ ] Try connecting again

---

## 📱 Build Release APK (Optional)

For installing on other devices:

### Step 1: Generate Signed APK
- [ ] In Android Studio: **Build → Generate Signed Bundle / APK**
- [ ] Select **APK**
- [ ] Click **Next**

### Step 2: Create Keystore (First time only)
- [ ] Click **Create new...**
- [ ] Choose save location
- [ ] Enter password (remember this!)
- [ ] Fill in key details
- [ ] Click **OK**

### Step 3: Build Release
- [ ] Select keystore file
- [ ] Enter keystore password
- [ ] Select key alias
- [ ] Enter key password
- [ ] Click **Next**
- [ ] Select **release** build variant
- [ ] Click **Finish**

### Step 4: Locate APK
- [ ] Wait for build to complete
- [ ] Click **locate** in notification
- [ ] APK location: `app/release/app-release.apk`
- [ ] Share this APK to install on other Android devices

---

## ✅ Final Verification

### All Systems Go
- [ ] Android app installed and running
- [ ] All permissions granted
- [ ] Bridge running on PC
- [ ] Web app running and showing connection
- [ ] Test call succeeded without chooser dialog
- [ ] Phone app opened immediately
- [ ] Call was made successfully

### Success Indicators
```
✅ Android App Screen: "Status: Active"
✅ Bridge Console: "Phone connected"
✅ Web App UI: "Connected" (green status)
✅ Test Call: Opened phone app directly (no chooser)
✅ Logcat: "Using default dialer: [package name]"
```

---

## 🎉 Complete!

If all checkboxes are marked, congratulations! Your DNK Dialer system is fully operational with the default dialer fix implemented.

**Key Achievement:** Calls now go directly to your default phone app without showing the annoying app chooser dialog! 🎯

---

## 📞 Quick Reference

| Component | Location | Port |
|-----------|----------|------|
| Android App | Phone | WebSocket Server: 8765 |
| Bridge | PC | WebSocket Server: 8766 |
| Web App | PC | HTTP: 3000 |

**Connection Flow:**
```
Web (3000) → Bridge (8766) → Android (8765) → Phone App
```

---

## 💡 Tips

1. **Keep the Android app running in background** on your phone
2. **Bridge must be running** before connecting web app
3. **Ensure same Wi-Fi** for phone and PC
4. **Check Logcat** if issues occur (filter: DNKDialer)
5. **Restart all components** if connection drops

---

**Ready to make calls from your PC through your Android phone!** 📱💻📞


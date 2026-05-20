# 🚀 Quick Start Guide - ComputerCaller Android App

## What This Fix Does

**Before:** When you clicked "Call" in the web dialer, your Android phone showed a dialog asking "Which app do you want to use?" every time.

**After:** Calls now go directly to your default phone app (Google Phone, Samsung Dialer, etc.) without any prompts!

---

## 🎯 The Fix (Technical Summary)

The key change is in `MainActivity.kt` lines 77-95:

```kotlin
// Get the default dialer package from Android system
val telecomManager = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
val defaultDialerPackage = telecomManager.defaultDialerPackage

// Set the intent to use ONLY that package
if (defaultDialerPackage != null) {
    callIntent.setPackage(defaultDialerPackage)  // 👈 THIS PREVENTS THE CHOOSER
}
```

By explicitly setting the package name, Android knows exactly which app to use and skips the chooser dialog.

---

## 📲 Installation Steps

### Step 1: Build the App (5 minutes)

1. Open **Android Studio**
2. **File** → **Open** → Select `C:\Users\D\Desktop\dnkdialerandroid`
3. Wait for Gradle sync (may take 2-5 minutes on first run)
4. Connect your Android phone via USB (with USB debugging enabled)
5. Click the **green Run button** (▶️) at the top
6. Select your device and click **OK**

### Step 2: Grant Permissions (1 minute)

When the app launches, tap **Allow** for all permission requests:
- 📞 Phone
- 💬 SMS
- 👥 Contacts
- 📋 Call Log

### Step 3: Connect Everything (2 minutes)

**On your PC:**
1. Start the bridge: 
   - Open folder: `C:\Users\D\Desktop\dnkdialer-bridge`
   - Run the bridge application
   
2. Start the web app:
   - Open folder: `C:\Users\D\Desktop\dnkdialer`
   - Run: `npm run dev`
   - Open browser: `http://localhost:3000`

**Get your phone's IP:**
- Settings → Wi-Fi → Tap connected network → Note IP (e.g., 192.168.1.100)

**Connect:**
- In the web app, enter your phone's IP address
- Click **Connect**
- Status should show "Connected" ✅

### Step 4: Test It! (30 seconds)

1. Type a phone number in the web dialer
2. Click the green **Call** button
3. Your phone should **immediately** start calling using your default phone app
4. **No chooser dialog!** 🎉

---

## ✅ Verification Checklist

After setup, verify these:

- [ ] Android app shows "Status: Active"
- [ ] Bridge shows "Phone connected"
- [ ] Web dialer shows "Connected"
- [ ] Test call goes directly to phone app (no chooser)
- [ ] Call appears in your regular phone app

---

## 🔧 If You Still See the Chooser

### Solution 1: Set Default Phone App

1. On Android: **Settings** → **Apps** → **Default Apps** → **Phone App**
2. Select your preferred app (e.g., "Phone" or "Google Phone")
3. Try calling again from web dialer

### Solution 2: Check Logs

1. In Android Studio, open **Logcat** (bottom panel)
2. Type in filter: `DNKDialer`
3. Look for: `"Using default dialer: com.google.android.dialer"` (or similar)
4. If it says "No default dialer set", go to Solution 1

### Solution 3: Reinstall

1. Uninstall the app from your phone
2. In Android Studio, click **Run** again
3. Grant all permissions when prompted

---

## 🎓 Understanding the Code

### Key File: `MainActivity.kt`

**Lines 65-106:** The `makeCall()` function that handles calls

```kotlin
fun makeCall(phoneNumber: String) {
    // 1. Clean the number
    val cleanNumber = phoneNumber.replace(Regex("[^0-9+*#]"), "")
    
    // 2. Create the call intent
    val callIntent = Intent(Intent.ACTION_CALL).apply {
        data = Uri.parse("tel:$cleanNumber")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }
    
    // 3. 🔑 THE FIX: Get and set default dialer
    val telecomManager = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    val defaultDialerPackage = telecomManager.defaultDialerPackage
    
    if (defaultDialerPackage != null) {
        callIntent.setPackage(defaultDialerPackage)  // Forces specific app
    }
    
    // 4. Start the call
    startActivity(callIntent)
}
```

### Why This Works

**Without `setPackage()`:**
- Android sees multiple apps can handle `tel:` URIs (Phone, WhatsApp, Skype, etc.)
- Shows chooser: "Open with Phone, WhatsApp, or Skype?"

**With `setPackage(defaultDialerPackage)`:**
- Android knows exactly which app to use
- Goes directly to that app
- No chooser needed!

---

## 📊 Testing Scenarios

Test these scenarios to ensure everything works:

| Test | Expected Result |
|------|----------------|
| Call from web dialer | Opens default phone app immediately |
| Call with +1 country code | Handles + correctly |
| Call with special chars | Cleans number automatically |
| Multiple calls in a row | Each call uses default app |
| SMS from web dialer | Opens messaging app |

---

## 🚨 Common Issues

### "Permission Denied"
**Fix:** Go to Settings → Apps → ComputerCaller → Permissions → Enable all

### "Connection Refused"
**Fix:** Ensure phone and PC are on the same Wi-Fi network

### "WebSocket Error"
**Fix:** Check that port 8765 is not blocked by firewall

### "App Crashes on Call"
**Fix:** Check Logcat for error, ensure CALL_PHONE permission is granted

---

## 🎯 Success!

You should now be able to:
- ✅ Make calls from your PC through your phone
- ✅ Calls go directly to your default phone app
- ✅ No more annoying app chooser dialogs
- ✅ Seamless dialing experience

---

## 📞 Architecture Flow

```
User types number in web browser (PC)
          ↓
Web app sends MAKE_CALL command
          ↓
Bridge forwards to Android app (WiFi)
          ↓
Android app receives command
          ↓
MainActivity.makeCall() is called
          ↓
Gets default dialer package name
          ↓
Creates Intent with setPackage()
          ↓
Launches directly to Phone app
          ↓
Call is made! ✅
```

---

## 🔄 Workflow Complete!

You've successfully implemented the fix. The app now:
1. Receives call commands via WebSocket
2. Queries the system for the default dialer
3. Sets the package explicitly
4. Launches the call directly

**No more chooser dialogs!** 🎉

---

Need help? Check the full README.md for detailed troubleshooting.


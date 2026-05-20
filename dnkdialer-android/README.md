# ComputerCaller - Android Companion App

This Android app acts as a bridge between the ComputerCaller web interface and your Android phone, allowing you to make calls and send SMS messages from your computer.

## 🎯 Key Feature: Uses Default Phone App Automatically

**Problem Solved:** Previously, when making a call, Android would show a chooser dialog asking which calling app to use. This app now **automatically uses your default phone/dialer app** without prompting.

### How It Works

The app uses Android's `TelecomManager` API to query the default dialer package:

```kotlin
val telecomManager = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
val defaultDialerPackage = telecomManager.defaultDialerPackage

if (defaultDialerPackage != null) {
    callIntent.setPackage(defaultDialerPackage)  // Forces use of default dialer
}
```

This ensures calls are made directly through your preferred phone app (e.g., Google Phone, Samsung Dialer, etc.).

---

## 📋 Prerequisites

- **Android Studio** (Arctic Fox or newer)
- **Android SDK** with API 26+ (Android 8.0+)
- **Java 8** or newer
- An Android device with Android 8.0 or higher

---

## 🚀 Setup Instructions

### 1. Open Project in Android Studio

1. Open Android Studio
2. Select **"Open an Existing Project"**
3. Navigate to: `C:\Users\D\Desktop\dnkdialerandroid`
4. Click **"OK"**

### 2. Sync Gradle

Android Studio will automatically start syncing Gradle. If it doesn't:
1. Click **File → Sync Project with Gradle Files**
2. Wait for the sync to complete

### 3. Connect Your Android Device

**Option A: Physical Device (Recommended)**
1. Enable **Developer Options** on your phone:
   - Go to **Settings → About Phone**
   - Tap **Build Number** 7 times
2. Enable **USB Debugging**:
   - Go to **Settings → Developer Options**
   - Enable **USB Debugging**
3. Connect phone via USB
4. Accept the debugging prompt on your phone

**Option B: Emulator**
1. Click **Tools → Device Manager**
2. Create a new virtual device
3. Select a device with API 26+
4. Click **Run**

### 4. Build and Install

1. Click the **Run** button (green play icon) in Android Studio
2. Select your device
3. Wait for the app to build and install

### 5. Grant Permissions

When the app launches, it will request permissions:
- ✅ **Phone** (to make calls)
- ✅ **SMS** (to send messages)
- ✅ **Contacts** (to access contact list)
- ✅ **Call Log** (to access call history)

**Grant all permissions** for full functionality.

---

## 🔌 Connecting to the Web Dialer

### 1. Find Your Phone's IP Address

**On Android:**
1. Go to **Settings → Network & Internet → Wi-Fi**
2. Tap on the connected network
3. Note the **IP Address** (e.g., `192.168.1.100`)

### 2. Start the Bridge

1. Navigate to: `C:\Users\D\Desktop\dnkdialer-bridge`
2. Run: `npm start` (or open the bridge app)

### 3. Connect from Web App

1. Open the web dialer at `http://localhost:3000`
2. Enter your phone's IP address
3. Click **Connect**

---

## 📱 Architecture

```
┌─────────────────┐
│   Web Dialer    │ (Next.js App on PC)
│  localhost:3000 │
└────────┬────────┘
         │ WebSocket
         │ Port 8766
┌────────▼────────┐
│  Bridge Server  │ (Electron App on PC)
│  localhost:8766 │
└────────┬────────┘
         │ WebSocket
         │ Port 8765
┌────────▼────────┐
│  Android App    │ (This App)
│   Phone Device  │
└────────┬────────┘
         │ Intent
┌────────▼────────┐
│  Default Dialer │ (Google Phone, etc.)
└─────────────────┘
```

---

## 🔧 Technical Details

### Key Files

| File | Purpose |
|------|---------|
| `MainActivity.kt` | Main activity with WebSocket server and call handling |
| `AndroidManifest.xml` | App permissions and configuration |
| `build.gradle` | Dependencies and build configuration |
| `activity_main.xml` | UI layout |

### WebSocket Protocol

The app listens on port **8765** for commands:

**Make Call:**
```
MAKE_CALL:{"number":"1234567890"}
```

**Send SMS:**
```
SEND_SMS:{"to":"1234567890","body":"Hello!"}
```

**End Call:**
```
END_CALL:{}
```

### Permissions Required

```xml
<uses-permission android:name="android.permission.CALL_PHONE"/>
<uses-permission android:name="android.permission.READ_PHONE_STATE"/>
<uses-permission android:name="android.permission.ANSWER_PHONE_CALLS"/>
<uses-permission android:name="android.permission.READ_CALL_LOG"/>
<uses-permission android:name="android.permission.SEND_SMS"/>
<uses-permission android:name="android.permission.RECEIVE_SMS"/>
<uses-permission android:name="android.permission.READ_SMS"/>
<uses-permission android:name="android.permission.READ_CONTACTS"/>
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>
```

---

## 🐛 Troubleshooting

### App Chooser Still Appears

If the app chooser still shows up:

1. **Set a Default Dialer:**
   - Go to **Settings → Apps → Default Apps → Phone App**
   - Select your preferred dialer (e.g., Google Phone)

2. **Check Logs:**
   - Open **Logcat** in Android Studio
   - Filter by "DNKDialer"
   - Look for the message: `"Using default dialer: [package_name]"`

3. **Verify TelecomManager:**
   - The log should show which package is being used
   - If it shows "No default dialer set", set one in Android settings

### Connection Issues

1. **Ensure same Wi-Fi network:** Phone and PC must be on the same network
2. **Check firewall:** Disable firewall temporarily to test
3. **Verify port 8765:** Make sure nothing else is using this port
4. **Check IP address:** Ensure you're using the correct phone IP

### Permission Denied

1. **Reinstall the app** and grant all permissions
2. Go to **Settings → Apps → ComputerCaller → Permissions**
3. Enable all permissions manually

---

## 📝 Development Notes

### Building Release APK

```bash
# In Android Studio:
# 1. Build → Generate Signed Bundle / APK
# 2. Select APK
# 3. Create or use existing keystore
# 4. Select "release" build variant
```

### Debugging

View logs in Android Studio Logcat:
```
adb logcat | grep DNKDialer
```

---

## 🎉 Success Indicators

When everything is working correctly, you should see:

1. ✅ **In the Android app:** "WebSocket Server" status shows "Active"
2. ✅ **In bridge logs:** "Phone connected"
3. ✅ **In web dialer:** Connection status shows "Connected"
4. ✅ **When calling:** Phone app opens immediately without chooser dialog

---

## 🔐 Security Notes

- The app uses **unencrypted WebSocket** (ws://) for simplicity
- Only use on **trusted local networks**
- For production, consider implementing **wss://** (WebSocket Secure)

---

## 📄 License

This project is for personal use.

---

## 🆘 Support

If you encounter issues:

1. Check Logcat for error messages
2. Verify all permissions are granted
3. Ensure phone and PC are on same network
4. Restart all components (app, bridge, web dialer)

**Log Tags to Monitor:**
- `DNKDialer` - Main app logs
- `DNKDialerWS` - WebSocket server logs


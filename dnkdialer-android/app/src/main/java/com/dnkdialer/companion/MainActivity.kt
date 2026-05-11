package com.dnkdialer.companion

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.widget.Toast
import com.dnkdialer.companion.R
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

class MainActivity : AppCompatActivity() {

    private var phoneService: PhoneService? = null
    private var serviceBound = false

    private lateinit var statusText: TextView
    private lateinit var ipText: TextView
    private lateinit var qrCodeImage: ImageView
    private lateinit var enableNotificationsButton: Button
    
    private var statusUpdateRunnable: Runnable? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    private val requiredPermissions = arrayOf(
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.ANSWER_PHONE_CALLS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_SMS,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.READ_CALL_LOG,
        Manifest.permission.CAMERA
    )
    
    private val optionalPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(Manifest.permission.POST_NOTIFICATIONS)
    } else {
        emptyArray()
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as PhoneService.LocalBinder
            phoneService = binder.getService()
            serviceBound = true
            android.util.Log.d("MainActivity", "Service connected")
            updateStatus()
            startStatusUpdates()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            phoneService = null
            serviceBound = false
            android.util.Log.d("MainActivity", "Service disconnected")
            stopStatusUpdates()
            updateStatus()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        ipText = findViewById(R.id.ipText)
        qrCodeImage = findViewById(R.id.qrCodeImage)
        enableNotificationsButton = findViewById(R.id.enable_notifications_button)
        
        // Enable Notifications button - opens system settings
        enableNotificationsButton.setOnClickListener {
            openNotificationSettings()
        }

        // Copy IP button - copies the displayed IP/URL to clipboard
        val copyIpButton: Button = findViewById(R.id.copyIpButton)
        copyIpButton.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val clip = android.content.ClipData.newPlainText("Phone IP", ipText.text.toString())
            clipboard.setPrimaryClip(clip)
            Toast.makeText(this, "IP copied!", Toast.LENGTH_SHORT).show()
        }

        // Reconnect button - asks the service to reconnect to the saved relay URL
        val reconnectButton: Button = findViewById(R.id.reconnectButton)
        reconnectButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Reconnect button pressed")
            phoneService?.reconnectToRelay()
        }

        // Disconnect button - stops the service and all connections
        val disconnectButton: Button = findViewById(R.id.disconnectButton)
        disconnectButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Disconnect button pressed")
            // Stop the service
            val stopIntent = Intent(this, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            stopService(stopIntent)
            if (serviceBound) {
                unbindService(serviceConnection)
                serviceBound = false
            }
            phoneService = null
            stopStatusUpdates()

            // Show brief disconnected state then restart so the user lands back on
            // the QR/IP screen ready to connect again (not stuck on a dead screen).
            statusText.text = "Disconnected"
            ipText.text = "Restarting..."
            disconnectButton.visibility = android.view.View.GONE
            reconnectButton.visibility = android.view.View.GONE
            qrCodeImage.setImageBitmap(null)

            handler.postDelayed({
                if (!serviceBound) {
                    statusText.text = "Ready to connect"
                    ipText.text = "Starting..."
                    startPhoneService()
                }
            }, 800)
        }
        
        // Check and show notification status
        checkNotificationStatus()

        // Auto-start flow: Request permissions and battery exemption
        if (hasPermissions()) {
            android.util.Log.d("MainActivity", "Permissions already granted")
            
            // Check battery optimization
            if (!isBatteryOptimizationDisabled()) {
                android.util.Log.d("MainActivity", "Requesting battery optimization exemption")
                statusText.text = "Please allow unrestricted battery usage..."
                ipText.text = "Required for background operation"
                requestBatteryOptimizationExemption()
            } else {
                android.util.Log.d("MainActivity", "Battery optimization already disabled, starting service")
                statusText.text = "Starting service..."
                ipText.text = "Connecting..."
                startPhoneService()
            }
        } else {
            android.util.Log.d("MainActivity", "Permissions not granted, requesting automatically")
            statusText.text = "Requesting permissions..."
            ipText.text = "Permissions needed"
            requestPermissions()
        }
    }

    private fun hasPermissions(): Boolean {
        val allGranted = requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        
        if (!allGranted) {
            // Log which permissions are missing
            requiredPermissions.forEach { permission ->
                val granted = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
                android.util.Log.d("MainActivity", "Permission $permission: ${if (granted) "GRANTED" else "DENIED"}")
            }
        }
        
        return allGranted
    }

    private fun requestPermissions() {
        android.util.Log.d("MainActivity", "Requesting permissions...")
        // Request all permissions together (required + optional)
        val allPermissions = requiredPermissions + optionalPermissions
        ActivityCompat.requestPermissions(this, allPermissions, 1)
    }
    
    private fun openNotificationSettings() {
        try {
            val intent = Intent()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent.action = android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS
                intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
            } else {
                intent.action = android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                intent.data = android.net.Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed to open notification settings", e)
            statusText.text = "Please enable notifications in system settings"
        }
    }
    
    private fun checkNotificationStatus() {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val areNotificationsEnabled = notificationManager.areNotificationsEnabled()
        
        if (!areNotificationsEnabled) {
            android.util.Log.d("MainActivity", "Notifications are blocked at system level")
            enableNotificationsButton.visibility = android.view.View.VISIBLE
        } else {
            android.util.Log.d("MainActivity", "Notifications are enabled")
            enableNotificationsButton.visibility = android.view.View.GONE
        }
    }
    
    private fun isBatteryOptimizationDisabled(): Boolean {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val isIgnoring = powerManager.isIgnoringBatteryOptimizations(packageName)
        android.util.Log.d("MainActivity", "Battery optimization disabled: $isIgnoring")
        return isIgnoring
    }
    
    private fun requestBatteryOptimizationExemption() {
        if (isBatteryOptimizationDisabled()) {
            android.util.Log.d("MainActivity", "Already exempt from battery optimization")
            return
        }
        
        try {
            android.util.Log.d("MainActivity", "Requesting battery optimization exemption")
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed to request battery optimization exemption", e)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        android.util.Log.d("MainActivity", "Permission result received, requestCode: $requestCode")
        
        if (requestCode == 1) { // Initial permissions request
            if (hasPermissions()) {
                android.util.Log.d("MainActivity", "All required permissions granted, auto-starting service")
                statusText.text = "Permissions granted, starting service..."
                ipText.text = "Connecting..."
                
                // Auto-start service immediately
                startPhoneService()
            } else {
                android.util.Log.d("MainActivity", "Some required permissions denied")
                val deniedPermissions = requiredPermissions.filter {
                    ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
                }

                // Check if any permission was permanently denied ("Don't ask again")
                val permanentlyDenied = deniedPermissions.any { perm ->
                    !ActivityCompat.shouldShowRequestPermissionRationale(this, perm)
                }

                if (permanentlyDenied) {
                    statusText.text = "Permissions permanently denied"
                    ipText.text = "Please grant permissions in App Settings"

                    // Show a button to open app settings
                    val disconnectButton: Button = findViewById(R.id.disconnectButton)
                    disconnectButton.text = "Open App Settings"
                    disconnectButton.visibility = android.view.View.VISIBLE
                    disconnectButton.setOnClickListener {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        startActivity(intent)
                    }
                } else {
                    statusText.text = "Permissions denied: ${deniedPermissions.size} required"
                    ipText.text = "Cannot start without permissions"
                }

                // Show which specific permissions were denied
                deniedPermissions.forEach {
                    android.util.Log.d("MainActivity", "Denied: $it")
                }
            }
        }
    }

    private fun startPhoneService() {
        android.util.Log.d("MainActivity", "startPhoneService called")
        val intent = Intent(this, PhoneService::class.java).apply {
            action = PhoneService.ACTION_START
        }
        
        try {
            // Use startForegroundService on Android O+ so the service can call startForeground()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            android.util.Log.d("MainActivity", "startService called")
            
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            android.util.Log.d("MainActivity", "bindService called")
            
            updateStatus()
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error starting service", e)
            statusText.text = "Error: ${e.message}"
            ipText.text = "Failed to start"
        }
    }

    private fun updateStatus() {
        android.util.Log.d("MainActivity", "updateStatus - serviceBound: $serviceBound, phoneService: ${phoneService != null}")
        if (serviceBound && phoneService != null) {
            val status = phoneService?.getServerStatus() ?: "Service not running"
            val ip = phoneService?.getServerStatus()?.let { s ->
                val ipMatch = Regex("IP: ([\\d.]+):8765").find(s)
                ipMatch?.groupValues?.get(1)
            } ?: "Unknown"

            if (ip != "Unknown" && ip.isNotEmpty()) {
                val wsUrl = "ws://$ip:8765"
                ipText.text = wsUrl
                generateQRCode(wsUrl)
            }

            val isActive = status.contains("Connected to relay") || status.contains("Connected from")
            // Extract hostname if present (e.g. "Connected from D-Omni-HP" or "Connected to relay (D-Omni-HP)")
            val hostnameMatch = Regex("\\(([^)]+)\\)|Connected from ([^\\s-]+[^\\s]*)").find(status)
            val hostname = hostnameMatch?.groupValues?.firstOrNull { it.isNotEmpty() && it != hostnameMatch.value }
            
            statusText.text = when {
                status.contains("Connected to relay") -> "✓ Connected via QR${if (hostname != null) " to $hostname" else ""}!"
                status.contains("Connected from") -> "✓ Connected to ${hostname ?: "web app"}!"
                status.contains("Waiting") -> "⏳ Waiting for web app..."
                else -> status
            }
            
            // Show disconnect + reconnect buttons when service is running
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.VISIBLE
            val reconnectButton: Button = findViewById(R.id.reconnectButton)
            reconnectButton.visibility = android.view.View.VISIBLE

            android.util.Log.d("MainActivity", "Status updated: ${statusText.text}")
        } else {
            statusText.text = "Service not running"
            ipText.text = "Not connected"
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.GONE
            val reconnectButton: Button = findViewById(R.id.reconnectButton)
            reconnectButton.visibility = android.view.View.GONE
            android.util.Log.d("MainActivity", "Status updated: Service not running")
        }
    }
    
    private fun generateQRCode(content: String) {
        try {
            val size = 512 // QR code size in pixels
            val hints = hashMapOf<EncodeHintType, Int>().apply {
                put(EncodeHintType.MARGIN, 1)
            }
            
            val qrCodeWriter = QRCodeWriter()
            val bitMatrix = qrCodeWriter.encode(content, BarcodeFormat.QR_CODE, size, size, hints)
            
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
            for (x in 0 until size) {
                for (y in 0 until size) {
                    bitmap.setPixel(x, y, if (bitMatrix[x, y]) Color.BLACK else Color.WHITE)
                }
            }
            
            qrCodeImage.setImageBitmap(bitmap)
            android.util.Log.d("MainActivity", "QR code generated successfully")
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error generating QR code", e)
        }
    }
    
    private fun startStatusUpdates() {
        statusUpdateRunnable = object : Runnable {
            override fun run() {
                updateStatus()
                handler.postDelayed(this, 2000) // Update every 2 seconds
            }
        }
        handler.post(statusUpdateRunnable!!)
    }
    
    private fun stopStatusUpdates() {
        statusUpdateRunnable?.let { handler.removeCallbacks(it) }
        statusUpdateRunnable = null
    }

    override fun onResume() {
        super.onResume()
        android.util.Log.d("MainActivity", "onResume called")
        
        // Check notification status on resume (user might have changed it in settings)
        checkNotificationStatus()
        
        // Check if user granted battery optimization exemption
        if (hasPermissions() && isBatteryOptimizationDisabled() && !serviceBound) {
            android.util.Log.d("MainActivity", "Battery exemption granted, starting service")
            statusText.text = "Starting service..."
            ipText.text = "Connecting..."
            startPhoneService()
        }
        
        // Try to rebind to service if it's running
        if (!serviceBound) {
            val intent = Intent(this, PhoneService::class.java)
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }
        
        // Always update status when resuming
        updateStatus()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopStatusUpdates()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }
}

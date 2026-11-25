package rip.kyc.xmradar

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import org.json.JSONObject
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebExtensionController
import org.mozilla.geckoview.WebNotification
import org.mozilla.geckoview.WebNotificationDelegate
import org.mozilla.geckoview.WebResponse
import rip.kyc.xmradar.NavigationPolicy.Compartment
import rip.kyc.xmradar.NavigationPolicy.Decision
import java.io.File

/**
 * Standalone GrapheneOS / Android shell for XMRadar (PLAN-ANDROID).
 *
 * Hosts Mozilla GeckoView with XMRadar's Firefox MV3 WebExtension bundled from APK assets,
 * opening directly into https://x.com inside an isolated `contextId = "x"` cookie jar so
 * GrapheneOS users never need the proprietary X APK.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "XMRadarAndroid"
        const val EXT_ID = "xmradar@local"
        const val EXT_URI = "resource://android/assets/xmradar/"
        const val EXT_SHA_ASSET = "xmradar/ext-sha256.txt"
        const val PREFS_NAME = "xmradar_shell"
        const val PREF_EXT_SHA = "installed_ext_sha256"
        const val PREF_FAB_RIGHT = "fab_snap_right"
        const val PREF_FAB_Y_RATIO = "fab_y_ratio"
        const val PREF_SIGNER_PKG = "nip55_signer_package"
        const val PREF_NOTIF_ORIGIN_PREFIX = "notif_perm_"
        const val PREF_NOTIF_ASKED = "notif_runtime_asked"
        const val X_HOME_URL = "https://x.com/home"
        const val CHAT_URL = "https://chat.xmr.club/?embed=1&room=x"
        const val SWAP_DEFAULT_URL = "https://kyc.rip/"
        const val X_AUTH_FLOW_TTL_MS = 10 * 60_000L
        const val NEW_SESSION_GESTURE_WINDOW_MS = 1_500L
        const val NIP55_INTERACTIVE_TIMEOUT_MS = 125_000L
        const val MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024

        // GeckoRuntime and live GeckoSessions are process-wide so Activity recreation
        // (e.g. lock/unlock or display config changes) re-attaches the exact live X tab
        // with zero reload and never calls GeckoRuntime.create() twice.
        @Volatile private var currentActivity: MainActivity? = null
        @Volatile private var sharedRuntime: GeckoRuntime? = null
        @Volatile private var sharedExtension: WebExtension? = null
        @Volatile private var sharedExtensionBaseUrl: String? = null
        @Volatile private var sharedPrivateBrowsingReady: Boolean = false
        private val runtimeLock = Any()

        private var sharedNextTabId: Int = 1
        private val sharedTabs = mutableListOf<TabEntry>()
        private var sharedActiveTab: TabEntry? = null
        private var sharedLastSiteTab: TabEntry? = null
    }

    private data class TabEntry(
        val id: Int,
        val compartment: Compartment,
        val session: GeckoSession,
        var currentUrl: String = "",
        var canGoBack: Boolean = false,
        var inXAuthFlowUntilMs: Long = 0L,
        var pendingFocus: Boolean = false,
        var lastSessionState: GeckoSession.SessionState? = null,
        var needsRecovery: Boolean = false,
        var recentRecoveries: Int = 0,
        var lastRecoveryAtMs: Long = 0L,
        var openedByUserTapAtMs: Long = 0L,
        val allowedSwapHosts: MutableSet<String> = mutableSetOf(),
    ) {
        fun isAuthFlowActive(nowMs: Long = System.currentTimeMillis()): Boolean =
            inXAuthFlowUntilMs > nowMs
    }

    private lateinit var rootContainer: FrameLayout
    private lateinit var geckoView: GeckoView
    private lateinit var progressBar: ProgressBar
    private lateinit var fabContainer: FrameLayout
    private lateinit var fabBadge: TextView

    private var runtime: GeckoRuntime? = null
    private var extension: WebExtension? = null
    private var ownExtensionBaseUrl: String? = null
    private var badgeText: String? = null
    @Volatile private var privateBrowsingReady = false
    @Volatile private var lastTouchGestureAtMs = 0L

    private val tabs: MutableList<TabEntry>
        get() = sharedTabs
    private var activeTab: TabEntry?
        get() = sharedActiveTab
        set(value) { sharedActiveTab = value }
    private var lastSiteTab: TabEntry?
        get() = sharedLastSiteTab
        set(value) { sharedLastSiteTab = value }
    private var activityStopped = false
    private var needsSurfaceRefreshOnResume = false
    private var screenUnlockReceiverRegistered = false
    private val screenUnlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_USER_PRESENT) {
                needsSurfaceRefreshOnResume = true
                if (!activityStopped) {
                    attachActiveTabToView(forceNewSurface = true)
                }
            }
        }
    }

    // Pending file picker callback for GeckoView PromptDelegate.onFilePrompt (X media uploads)
    private var pendingFileCallback: ((Uri?) -> Unit)? = null
    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val cb = pendingFileCallback
        pendingFileCallback = null
        cb?.invoke(uri)
    }

    // Pending download save callback for ContentDelegate.onExternalResponse (SIWM message / receipt exports)
    private val downloadExecutor = Executors.newSingleThreadExecutor()
    private var pendingDownloadBytes: ByteArray? = null
    private val createDocumentLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val bytes = pendingDownloadBytes
        pendingDownloadBytes = null
        if (uri != null && bytes != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                Toast.makeText(this, "Saved file", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save download", e)
                Toast.makeText(this, "Could not save file", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // Serialized interactive NIP-55 Android signer bridge (Amber, etc.)
    private data class SignerAppInfo(val packageName: String, val label: String)
    private val nip55Executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var signerPickerInFlight = false
    private var pendingNip55Callback: ((Int, Intent?) -> Unit)? = null
    private var pendingNip55Timeout: Runnable? = null
    private val nip55Launcher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        cancelPendingNip55Timeout()
        val cb = pendingNip55Callback
        pendingNip55Callback = null
        cb?.invoke(res.resultCode, res.data)
    }

    private fun cancelPendingNip55Timeout() {
        pendingNip55Timeout?.let { mainHandler.removeCallbacks(it) }
        pendingNip55Timeout = null
    }

    private fun armPendingNip55Callback(cb: (Int, Intent?) -> Unit) {
        cancelPendingNip55Timeout()
        pendingNip55Callback = cb
        val timeout = Runnable {
            val stale = pendingNip55Callback
            pendingNip55Callback = null
            pendingNip55Timeout = null
            stale?.invoke(Activity.RESULT_CANCELED, null)
        }
        pendingNip55Timeout = timeout
        mainHandler.postDelayed(timeout, NIP55_INTERACTIVE_TIMEOUT_MS)
    }

    private fun cancelPendingNip55Request() {
        cancelPendingNip55Timeout()
        val stale = pendingNip55Callback
        pendingNip55Callback = null
        stale?.invoke(Activity.RESULT_CANCELED, null)
    }

    private var pendingNotificationTap: NotificationBridge.ActiveNotification? = null
    private val pendingNotifPermCallbacks = mutableListOf<(Boolean) -> Unit>()
    private val pendingOriginNotifResults = mutableMapOf<String, MutableList<GeckoResult<Int>>>()
    private val activeDialogs = mutableListOf<Dialog>()
    private var notifPermRequestInFlight = false

    private fun showTrackedDialog(dialog: Dialog, onDismissExtra: (() -> Unit)? = null): Boolean {
        if (isFinishing || isDestroyed) return false
        dialog.setOnDismissListener {
            activeDialogs.remove(dialog)
            onDismissExtra?.invoke()
        }
        activeDialogs.add(dialog)
        dialog.show()
        return true
    }

    private fun applySheetBottomInsets(view: View) {
        val baseBottom = view.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bottom = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime(),
            ).bottom
            v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, baseBottom + bottom)
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    private fun <T> completeOnce(result: GeckoResult<T>): (T) -> Unit {
        val done = AtomicBoolean(false)
        return { value ->
            if (done.compareAndSet(false, true)) {
                result.complete(value)
            }
        }
    }

    private fun runOnNip55(onRejected: () -> Unit, task: () -> Unit) {
        if (isFinishing || isDestroyed || nip55Executor.isShutdown) {
            onRejected()
            return
        }
        try {
            nip55Executor.execute {
                if (isFinishing || isDestroyed) {
                    onRejected()
                    return@execute
                }
                task()
            }
        } catch (_: RejectedExecutionException) {
            onRejected()
        }
    }
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            notifPermRequestInFlight = false
            val callbacks = pendingNotifPermCallbacks.toList()
            pendingNotifPermCallbacks.clear()
            for (cb in callbacks) cb(granted)
        }

    private fun hasPostNotificationsPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun ensurePostNotificationsPermission(onResult: (Boolean) -> Unit) {
        if (hasPostNotificationsPermission()) {
            onResult(true)
            return
        }
        pendingNotifPermCallbacks.add(onResult)
        if (!notifPermRequestInFlight) {
            notifPermRequestInFlight = true
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putBoolean(PREF_NOTIF_ASKED, true)
                .apply()
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun openAppNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        }
        try {
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, R.string.notif_denied, Toast.LENGTH_LONG).show()
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val xmradarChannel = NotificationChannel(
            NotificationBridge.CHANNEL_XMRADAR,
            getString(R.string.notif_channel_xmradar),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        val webChannel = NotificationChannel(
            NotificationBridge.CHANNEL_WEB,
            getString(R.string.notif_channel_web),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        nm.createNotificationChannels(listOf(xmradarChannel, webChannel))
    }

    private fun extractNotificationTap(intent: Intent?): NotificationBridge.ActiveNotification? {
        if (intent == null) return null
        val id = intent.getIntExtra(NotificationBridge.EXTRA_NOTIF_ID, 0)
        val token = intent.getStringExtra(NotificationBridge.EXTRA_NOTIF_TOKEN)
        intent.removeExtra(NotificationBridge.EXTRA_NOTIF_ID)
        intent.removeExtra(NotificationBridge.EXTRA_NOTIF_TOKEN)
        if (id == 0 || token.isNullOrEmpty()) return null
        return NotificationRegistry.takeIfTokenMatches(id, token)
    }

    private fun dispatchNotificationTap(active: NotificationBridge.ActiveNotification) {
        when (active.target.compartment) {
            Compartment.X -> openOrFocusCompartment(Compartment.X, X_HOME_URL)
            Compartment.CHAT -> openOrFocusCompartment(Compartment.CHAT, CHAT_URL)
            Compartment.EXTENSION, Compartment.SWAP -> Unit
        }
        try {
            active.notification.click()
        } catch (e: Exception) {
            Log.w(TAG, "WebNotification.click() failed", e)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        currentActivity = this
        // Consume verified in-process notification taps before scrubbing external intent data.
        pendingNotificationTap = extractNotificationTap(intent)
        // Security: never honor arbitrary external data/URLs pushed into MainActivity via Intent.
        intent?.data = null

        setContentView(R.layout.activity_main)
        createNotificationChannels()
        registerScreenUnlockReceiver()
        bindViews()
        applyEdgeToEdgeInsets()
        updateSafeAreaChrome(Compartment.X)
        setupBackNavigation()

        val rt = initRuntime()
        runtime = rt

        val existingExt = sharedExtension
        if (existingExt != null && tabs.isNotEmpty()) {
            // Fast in-process re-attach after Activity recreation: rebind delegates to this new
            // Activity instance without closing or reloading the live X/Chat GeckoSessions.
            extension = existingExt
            ownExtensionBaseUrl = sharedExtensionBaseUrl ?: existingExt.metaData.baseUrl
            privateBrowsingReady = sharedPrivateBrowsingReady
            for (t in tabs) {
                wireSessionDelegates(t)
            }
            attachExtensionDelegates(existingExt)
            val target = activeTab?.takeIf { it in tabs } ?: tabs.last()
            activeTab = target
            updateSafeAreaChrome(target.compartment)
            attachActiveTabToView(forceNewSurface = false)
            pendingNotificationTap?.let { tap ->
                pendingNotificationTap = null
                dispatchNotificationTap(tap)
            }
        } else {
            installOrEnsureExtension(rt)
        }
    }

    private fun registerScreenUnlockReceiver() {
        if (screenUnlockReceiverRegistered) return
        val filter = IntentFilter(Intent.ACTION_USER_PRESENT)
        ContextCompat.registerReceiver(this, screenUnlockReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        screenUnlockReceiverRegistered = true
    }

    override fun onStart() {
        super.onStart()
        val refreshSurface = activityStopped || needsSurfaceRefreshOnResume
        activityStopped = false
        attachActiveTabToView(forceNewSurface = refreshSurface)
    }

    override fun onResume() {
        super.onResume()
        val refreshSurface = activityStopped || needsSurfaceRefreshOnResume
        activityStopped = false
        attachActiveTabToView(forceNewSurface = refreshSurface)
    }

    override fun onPause() {
        activeTab?.session?.takeIf { it.isOpen }?.flushSessionState()
        super.onPause()
    }

    override fun onStop() {
        // Keep the GeckoSession attached and priority intact across lock/unlock (matching Firefox
        // for Android) so GrapheneOS doesn't kill the content process and force X to reload;
        // refresh the SurfaceView cleanly on unlock via requestNewSurface().
        activityStopped = true
        needsSurfaceRefreshOnResume = true
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && !activityStopped) {
            attachActiveTabToView(forceNewSurface = needsSurfaceRefreshOnResume)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateSafeAreaChrome(activeTab?.compartment ?: Compartment.X)
        rootContainer.post { repositionFab() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val tap = extractNotificationTap(intent)
        // Ignore external intents pushing URLs into our trusted session.
        intent.data = null
        if (tap != null) {
            if (tabs.isEmpty()) {
                pendingNotificationTap = tap
            } else {
                dispatchNotificationTap(tap)
            }
        }
    }

    private fun bindViews() {
        rootContainer = findViewById(R.id.root)
        geckoView = findViewById(R.id.gecko_view)
        progressBar = findViewById(R.id.progress_bar)
        fabContainer = findViewById(R.id.fab_container)
        fabBadge = findViewById(R.id.fab_badge)

        setupFloatingButton()

        // Record real OS touch-up gestures on GeckoView (unforgeable by web JS) so user-clicked
        // target="_blank" / window.open external links (e.g. t.co on X) can hand off to Vanadium
        // while script-driven window.open calls without a tap remain blocked.
        geckoView.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                lastTouchGestureAtMs = SystemClock.uptimeMillis()
            }
            false
        }
    }

    private fun repositionFab() {
        val marginPx = (12 * resources.displayMetrics.density).toInt()
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val w = rootContainer.width - rootContainer.paddingLeft - rootContainer.paddingRight
        val h = rootContainer.height - rootContainer.paddingTop - rootContainer.paddingBottom
        if (w <= 0 || h <= 0 || fabContainer.width <= 0 || fabContainer.height <= 0) return
        val snapRight = prefs.getBoolean(PREF_FAB_RIGHT, true)
        val yRatio = prefs.getFloat(PREF_FAB_Y_RATIO, 0.48f).coerceIn(0.10f, 0.85f)
        val targetX = if (snapRight) {
            (rootContainer.width - rootContainer.paddingRight - fabContainer.width - marginPx).toFloat()
        } else {
            (rootContainer.paddingLeft + marginPx).toFloat()
        }
        val minY = (rootContainer.paddingTop + marginPx).toFloat()
        val maxY = (rootContainer.height - rootContainer.paddingBottom - fabContainer.height - marginPx).toFloat().coerceAtLeast(minY)
        fabContainer.x = targetX
        fabContainer.y = (rootContainer.paddingTop + h * yRatio).coerceIn(minY, maxY)
    }

    private fun toggleXOrMenu() {
        if (isFinishing || isDestroyed) return
        if (activeTab?.compartment == Compartment.X) {
            openExtensionUi("popup.html")
        } else {
            openOrFocusCompartment(Compartment.X, X_HOME_URL)
        }
    }

    private fun setupFloatingButton() {
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        val marginPx = (12 * resources.displayMetrics.density).toInt()
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        // Restore saved edge & vertical position once laid out.
        rootContainer.post { repositionFab() }

        // Accessibility / TalkBack click & long-click delegates.
        fabContainer.setOnClickListener {
            if (!isFinishing && !isDestroyed) showNavSheet()
        }
        fabContainer.setOnLongClickListener {
            toggleXOrMenu()
            true
        }

        var downRawX = 0f
        var downRawY = 0f
        var startX = 0f
        var startY = 0f
        var dragging = false
        var longPressed = false
        val longPressRunnable = Runnable {
            if (!dragging && !isFinishing && !isDestroyed) {
                longPressed = true
                // Long-press quick-toggles between X and XMRadar menu.
                toggleXOrMenu()
            }
        }

        fabContainer.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = v.x
                    startY = v.y
                    dragging = false
                    longPressed = false
                    v.postDelayed(longPressRunnable, ViewConfiguration.getLongPressTimeout().toLong())
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        dragging = true
                        v.removeCallbacks(longPressRunnable)
                    }
                    if (dragging) {
                        val minX = (rootContainer.paddingLeft + marginPx).toFloat()
                        val maxX = (rootContainer.width - rootContainer.paddingRight - v.width - marginPx).toFloat().coerceAtLeast(minX)
                        val minY = (rootContainer.paddingTop + marginPx).toFloat()
                        val maxY = (rootContainer.height - rootContainer.paddingBottom - v.height - marginPx).toFloat().coerceAtLeast(minY)
                        v.x = (startX + dx).coerceIn(minX, maxX)
                        v.y = (startY + dy).coerceIn(minY, maxY)
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.removeCallbacks(longPressRunnable)
                    if (dragging) {
                        val mid = rootContainer.width / 2f
                        val snapRight = (v.x + v.width / 2f) >= mid
                        val targetX = if (snapRight) {
                            (rootContainer.width - rootContainer.paddingRight - v.width - marginPx).toFloat()
                        } else {
                            (rootContainer.paddingLeft + marginPx).toFloat()
                        }
                        v.animate().x(targetX).setDuration(160).start()
                        val usableH = (rootContainer.height - rootContainer.paddingTop - rootContainer.paddingBottom).coerceAtLeast(1)
                        val ratio = ((v.y - rootContainer.paddingTop) / usableH).coerceIn(0.10f, 0.85f)
                        prefs.edit().putBoolean(PREF_FAB_RIGHT, snapRight).putFloat(PREF_FAB_Y_RATIO, ratio).apply()
                    } else if (!longPressed && event.actionMasked == MotionEvent.ACTION_UP) {
                        v.performClick()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun showNavSheet() {
        if (isFinishing || isDestroyed) return
        val dialog = BottomSheetDialog(this)
        val view = layoutInflater.inflate(R.layout.sheet_nav, null)
        dialog.setContentView(view)

        val active = activeTab?.compartment
        val isOptions = active == Compartment.EXTENSION && activeTab?.currentUrl?.contains("options.html") == true
        val isPopup = active == Compartment.EXTENSION && !isOptions

        val hint = view.findViewById<TextView>(R.id.sheet_compartment_hint)
        hint.text = when {
            active == Compartment.X -> "On X"
            isOptions -> "Options"
            isPopup -> "XMRadar menu"
            active == Compartment.CHAT -> "Chat"
            active == Compartment.SWAP -> "Private Swap tab"
            else -> ""
        }

        val accent = getColor(R.color.accent)
        val fg = getColor(R.color.fg)

        val rowX = view.findViewById<Button>(R.id.sheet_x)
        val rowXmradar = view.findViewById<Button>(R.id.sheet_xmradar)
        val rowChat = view.findViewById<Button>(R.id.sheet_chat)
        val rowSwap = view.findViewById<Button>(R.id.sheet_swap)
        val rowOptions = view.findViewById<Button>(R.id.sheet_options)
        val rowNotifications = view.findViewById<Button>(R.id.sheet_notifications)

        rowX.setTextColor(if (active == Compartment.X) accent else fg)
        rowXmradar.setTextColor(if (isPopup) accent else fg)
        rowChat.setTextColor(if (active == Compartment.CHAT) accent else fg)
        rowSwap.setTextColor(if (active == Compartment.SWAP) accent else fg)
        rowOptions.setTextColor(if (isOptions) accent else fg)

        badgeText?.let { b ->
            rowXmradar.text = "${getString(R.string.sheet_xmradar)} · $b"
        }

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val hasBlockedWebOrigin = listOf("https://x.com", "https://chat.xmr.club").any { origin ->
            val key = PREF_NOTIF_ORIGIN_PREFIX + origin
            prefs.contains(key) && !prefs.getBoolean(key, true)
        }
        val notifBlocked = !hasPostNotificationsPermission() ||
            !NotificationManagerCompat.from(this).areNotificationsEnabled() ||
            hasBlockedWebOrigin
        rowNotifications.visibility = if (notifBlocked) View.VISIBLE else View.GONE
        rowNotifications.setOnClickListener {
            dialog.dismiss()
            if (hasBlockedWebOrigin) {
                prefs.edit()
                    .remove(PREF_NOTIF_ORIGIN_PREFIX + "https://x.com")
                    .remove(PREF_NOTIF_ORIGIN_PREFIX + "https://chat.xmr.club")
                    .apply()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPostNotificationsPermission()) {
                val askedBefore = prefs.getBoolean(PREF_NOTIF_ASKED, false)
                if (askedBefore && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                    openAppNotificationSettings()
                } else {
                    ensurePostNotificationsPermission { granted ->
                        Toast.makeText(
                            this,
                            if (granted) R.string.notif_enabled else R.string.notif_denied,
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            } else if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
                openAppNotificationSettings()
            } else {
                Toast.makeText(this, R.string.notif_enabled, Toast.LENGTH_SHORT).show()
            }
        }

        rowX.setOnClickListener {
            dialog.dismiss()
            openOrFocusCompartment(Compartment.X, X_HOME_URL)
        }
        rowXmradar.setOnClickListener {
            dialog.dismiss()
            openExtensionUi("popup.html")
        }
        rowChat.setOnClickListener {
            dialog.dismiss()
            openOrFocusCompartment(Compartment.CHAT, CHAT_URL)
        }
        rowSwap.setOnClickListener {
            dialog.dismiss()
            showSwapUrlDialog()
        }
        rowOptions.setOnClickListener {
            dialog.dismiss()
            openExtensionUi("options.html")
        }
        if (showTrackedDialog(dialog)) {
            applySheetBottomInsets(view)
        }
    }

    /** Consumes a single recent OS touch gesture token (prevents multi-popup spam from one tap). */
    private fun consumeRecentTouchGesture(): Boolean {
        val now = SystemClock.uptimeMillis()
        val last = lastTouchGestureAtMs
        if (last > 0L && now - last <= NEW_SESSION_GESTURE_WINDOW_MS) {
            lastTouchGestureAtMs = 0L
            return true
        }
        return false
    }

    private fun applyEdgeToEdgeInsets() {
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            v.post { repositionFab() }
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun updateSafeAreaChrome(compartment: Compartment) {
        val isNight = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val bg = when (compartment) {
            Compartment.X -> if (isNight) Color.BLACK else Color.WHITE
            else -> getColor(R.color.bg)
        }
        rootContainer.setBackgroundColor(bg)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = !isNight
        controller.isAppearanceLightNavigationBars = !isNight
    }

    private fun isXHomeUrl(url: String): Boolean {
        if (url.isBlank()) return false
        return try {
            val u = Uri.parse(url)
            val host = u.host?.lowercase() ?: return false
            val path = (u.path ?: "").trimEnd('/')
            (host == "x.com" || host == "mobile.x.com" || host == "twitter.com") &&
                (path.isEmpty() || path == "/home")
        } catch (_: Exception) {
            false
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val cur = activeTab
                if (cur != null && cur.canGoBack) {
                    cur.session.goBack()
                    return
                }
                if (cur != null && (cur.compartment != Compartment.X || tabs.count { it.compartment == Compartment.X } > 1)) {
                    closeTab(cur)
                    return
                }
                if (cur != null && cur.compartment == Compartment.X && !isXHomeUrl(cur.currentUrl)) {
                    cur.session.loadUri(X_HOME_URL)
                    return
                }
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
    }

    private fun initRuntime(): GeckoRuntime {
        sharedRuntime?.let { return it }
        return synchronized(runtimeLock) {
            sharedRuntime?.let { return@synchronized it }
            val settings = GeckoRuntimeSettings.Builder()
                .allowInsecureConnections(GeckoRuntimeSettings.HTTPS_ONLY)
                .webManifest(true)
                .preferredColorScheme(GeckoRuntimeSettings.COLOR_SCHEME_SYSTEM)
                .doubleTapZoomingEnabled(false)
                .inputAutoZoomEnabled(false)
                .crashHandler(null)
                .experimentDelegate(null)
                .aboutConfigEnabled(false)
                .remoteDebuggingEnabled(BuildConfig.DEBUG)
                .consoleOutput(BuildConfig.DEBUG)
                .build()
            val appCtx = applicationContext
            GeckoRuntime.create(appCtx, settings).also { rt ->
                rt.webNotificationDelegate = createProcessWebNotificationDelegate(appCtx)
                sharedRuntime = rt
            }
        }
    }

    /**
     * Process-wide GeckoView WebNotificationDelegate using `applicationContext` only (never capturing
     * an Activity reference across recreations). Bridges both XMRadar WebExtension notifications
     * (`browser.notifications.create`) and allowlisted X / Chat PWA web notifications.
     */
    private fun createProcessWebNotificationDelegate(appCtx: Context): WebNotificationDelegate {
        val uiHandler = Handler(Looper.getMainLooper())
        return object : WebNotificationDelegate {
            override fun onShowNotification(notification: WebNotification) {
                val target = NotificationBridge.classifyNotification(
                    origin = notification.origin,
                    source = notification.source,
                    ownExtensionBaseUrl = sharedExtensionBaseUrl,
                    privateBrowsing = notification.privateBrowsing,
                )
                if (target == null) {
                    Log.d(TAG, "Suppressed WebNotification (private=${notification.privateBrowsing} origin=${notification.origin})")
                    uiHandler.post { notification.dismiss() }
                    return
                }
                val hasOsPerm = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                    ContextCompat.checkSelfPermission(appCtx, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
                val nm = NotificationManagerCompat.from(appCtx)
                if (!hasOsPerm || !nm.areNotificationsEnabled()) {
                    uiHandler.post { notification.dismiss() }
                    return
                }

                val notifId = NotificationBridge.notificationIdFor(target.originKey, notification.tag)
                val reg = NotificationRegistry.register(notifId, target, notification.tag, notification)
                for (evicted in reg.evicted) {
                    nm.cancel(evicted.id)
                    uiHandler.post {
                        try {
                            evicted.notification.dismiss()
                        } catch (_: Exception) {
                        }
                    }
                }
                val token = reg.token

                val tapIntent = Intent(appCtx, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(NotificationBridge.EXTRA_NOTIF_ID, notifId)
                    putExtra(NotificationBridge.EXTRA_NOTIF_TOKEN, token)
                }
                val tapPending = PendingIntent.getActivity(
                    appCtx,
                    notifId,
                    tapIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )

                val dismissIntent = Intent(appCtx, NotificationDismissReceiver::class.java).apply {
                    action = NotificationBridge.ACTION_DISMISS
                    putExtra(NotificationBridge.EXTRA_NOTIF_ID, notifId)
                    putExtra(NotificationBridge.EXTRA_NOTIF_TOKEN, token)
                }
                val dismissPending = PendingIntent.getBroadcast(
                    appCtx,
                    notifId xor 0x40000000,
                    dismissIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )

                val title = NotificationBridge.sanitizeText(
                    notification.title,
                    NotificationBridge.MAX_TITLE_CHARS,
                    target.defaultTitle,
                )
                val body = NotificationBridge.sanitizeText(
                    notification.text,
                    NotificationBridge.MAX_BODY_CHARS,
                    "",
                )

                val builder = NotificationCompat.Builder(appCtx, target.channelId)
                    .setSmallIcon(R.drawable.ic_stat_xmradar)
                    .setContentTitle(title)
                    .setAutoCancel(true)
                    .setSilent(notification.silent)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setContentIntent(tapPending)
                    .setDeleteIntent(dismissPending)
                if (body.isNotEmpty()) {
                    builder.setContentText(body)
                        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                }

                try {
                    nm.notify(notifId, builder.build())
                    uiHandler.post {
                        try {
                            notification.show()
                        } catch (_: Exception) {
                        }
                    }
                } catch (e: RuntimeException) {
                    Log.w(TAG, "Notification post failed", e)
                    NotificationRegistry.remove(notifId)
                    uiHandler.post {
                        try {
                            notification.dismiss()
                        } catch (_: Exception) {
                        }
                    }
                }
            }

            override fun onCloseNotification(notification: WebNotification) {
                val target = NotificationBridge.classifyNotification(
                    origin = notification.origin,
                    source = notification.source,
                    ownExtensionBaseUrl = sharedExtensionBaseUrl,
                    privateBrowsing = notification.privateBrowsing,
                )
                val removedId = NotificationRegistry.removeByNotificationOrTag(
                    notification = notification,
                    originKey = target?.originKey,
                    tag = notification.tag,
                )
                if (removedId != null) {
                    NotificationManagerCompat.from(appCtx).cancel(removedId)
                }
            }
        }
    }

    private fun readBundledExtensionSha(): String = try {
        assets.open(EXT_SHA_ASSET).bufferedReader().use { it.readText().trim() }
    } catch (e: Exception) {
        Log.w(TAG, "Missing $EXT_SHA_ASSET", e)
        BuildConfig.VERSION_NAME
    }

    private fun installOrEnsureExtension(rt: GeckoRuntime) {
        val controller = rt.webExtensionController
        controller.promptDelegate = object : WebExtensionController.PromptDelegate {
            override fun onInstallPromptRequest(
                ext: WebExtension,
                permissions: Array<String>,
                origins: Array<String>,
                dataCollectionPermissions: Array<String>,
            ): GeckoResult<WebExtension.PermissionPromptResponse> {
                val allow = ext.id == EXT_ID
                return GeckoResult.fromValue(
                    WebExtension.PermissionPromptResponse(allow, allow, false)
                )
            }

            override fun onUpdatePrompt(
                ext: WebExtension,
                permissions: Array<String>,
                origins: Array<String>,
                dataCollectionPermissions: Array<String>,
            ): GeckoResult<AllowOrDeny> {
                return GeckoResult.fromValue(
                    if (ext.id == EXT_ID) AllowOrDeny.ALLOW else AllowOrDeny.DENY
                )
            }

            override fun onOptionalPrompt(
                ext: WebExtension,
                permissions: Array<String>,
                origins: Array<String>,
                dataCollectionPermissions: Array<String>,
            ): GeckoResult<AllowOrDeny> {
                return GeckoResult.fromValue(
                    if (ext.id == EXT_ID) AllowOrDeny.ALLOW else AllowOrDeny.DENY
                )
            }
        }

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val bundledSha = readBundledExtensionSha()
        val installedSha = prefs.getString(PREF_EXT_SHA, null)
        val needsFreshInstall = installedSha != bundledSha

        Log.i(TAG, "Loading built-in extension ($EXT_ID), freshInstall=$needsFreshInstall sha=${bundledSha.take(12)}")
        val op = if (needsFreshInstall) {
            controller.installBuiltIn(EXT_URI)
        } else {
            controller.ensureBuiltIn(EXT_URI, EXT_ID)
        }

        op.accept(
            { ext ->
                if (ext == null) {
                    Log.e(TAG, "Built-in extension returned null")
                    openOrFocusCompartment(Compartment.X, X_HOME_URL)
                    return@accept
                }
                prefs.edit().putString(PREF_EXT_SHA, bundledSha).apply()
                onExtensionReady(rt, ext)
            },
            { err ->
                Log.e(TAG, "Failed to install/ensure built-in extension; retrying installBuiltIn", err)
                controller.installBuiltIn(EXT_URI).accept(
                    { ext ->
                        if (ext != null) {
                            prefs.edit().putString(PREF_EXT_SHA, bundledSha).apply()
                            onExtensionReady(rt, ext)
                        } else {
                            openOrFocusCompartment(Compartment.X, X_HOME_URL)
                        }
                    },
                    { err2 ->
                        Log.e(TAG, "Built-in extension install failed permanently", err2)
                        openOrFocusCompartment(Compartment.X, X_HOME_URL)
                    }
                )
            }
        )
    }

    private fun onExtensionReady(rt: GeckoRuntime, ext: WebExtension) {
        extension = ext
        sharedExtension = ext
        ownExtensionBaseUrl = ext.metaData.baseUrl
        sharedExtensionBaseUrl = ext.metaData.baseUrl
        Log.i(TAG, "Extension ready: id=${ext.id} version=${ext.metaData.version} baseUrl=$ownExtensionBaseUrl")

        attachExtensionDelegates(ext)

        val launchXIfNeeded = {
            runOnUiThread {
                if (tabs.isEmpty()) {
                    openOrFocusCompartment(Compartment.X, X_HOME_URL)
                }
                pendingNotificationTap?.let { tap ->
                    pendingNotificationTap = null
                    dispatchNotificationTap(tap)
                }
            }
        }

        // Fast path: skip addOptionalPermissions & setAllowedInPrivateBrowsing when already granted
        // so normal app launches avoid two full WebExtension reloads before opening X.
        val hasAllUrls = ext.metaData.grantedOptionalOrigins.contains("<all_urls>")
        val hasPrivate = ext.metaData.allowedInPrivateBrowsing
        if (hasAllUrls && hasPrivate) {
            privateBrowsingReady = true
            sharedPrivateBrowsingReady = true
            Log.i(TAG, "Permissions & private browsing already granted for ${ext.id}; launching X immediately")
            launchXIfNeeded()
            return
        }

        val controller = rt.webExtensionController
        val ensurePrivateAndLaunch: (WebExtension) -> Unit = { permExt ->
            if (permExt.metaData.allowedInPrivateBrowsing) {
                privateBrowsingReady = true
                sharedPrivateBrowsingReady = true
                Log.i(TAG, "Private browsing already enabled for ${permExt.id}; launching X")
                launchXIfNeeded()
            } else {
                controller.setAllowedInPrivateBrowsing(permExt, true).accept(
                    { afterPriv ->
                        val finalExt = afterPriv ?: permExt
                        extension = finalExt
                        sharedExtension = finalExt
                        ownExtensionBaseUrl = finalExt.metaData.baseUrl
                        sharedExtensionBaseUrl = finalExt.metaData.baseUrl
                        attachExtensionDelegates(finalExt)
                        privateBrowsingReady = true
                        sharedPrivateBrowsingReady = true
                        Log.i(TAG, "Private browsing enabled for ${finalExt.id}; launching X")
                        launchXIfNeeded()
                    },
                    { err ->
                        privateBrowsingReady = false
                        sharedPrivateBrowsingReady = false
                        Log.e(TAG, "setAllowedInPrivateBrowsing failed; private Swap disabled until retry", err)
                        launchXIfNeeded()
                    }
                )
            }
        }

        if (hasAllUrls) {
            ensurePrivateAndLaunch(ext)
            return
        }

        // Grant MV3 host_permissions (<all_urls>) then private-browsing access sequentially so the
        // final WebExtension instance gets our TabDelegate, ActionDelegate, and MessageDelegate cleanly.
        controller.addOptionalPermissions(ext.id, emptyArray(), arrayOf("<all_urls>"), emptyArray())
            .accept(
                { afterPerm ->
                    val permExt = afterPerm ?: ext
                    extension = permExt
                    sharedExtension = permExt
                    ownExtensionBaseUrl = permExt.metaData.baseUrl
                    sharedExtensionBaseUrl = permExt.metaData.baseUrl
                    attachExtensionDelegates(permExt)
                    Log.i(TAG, "Granted <all_urls> optional host permissions to ${permExt.id}")
                    ensurePrivateAndLaunch(permExt)
                },
                { err ->
                    Log.e(TAG, "Failed to grant <all_urls> host permissions", err)
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        val dlg = AlertDialog.Builder(this)
                            .setTitle("Site access required")
                            .setMessage("XMRadar could not enable site access for its built-in extension. Swap Guard and X badges cannot run without it.")
                            .setCancelable(false)
                            .setPositiveButton("Retry") { _, _ -> onExtensionReady(rt, ext) }
                            .setNegativeButton("Exit") { _, _ -> finish() }
                            .create()
                        showTrackedDialog(dlg)
                    }
                }
            )
    }

    private fun attachExtensionDelegates(ext: WebExtension) {
        ext.tabDelegate = object : WebExtension.TabDelegate {
            override fun onNewTab(
                source: WebExtension,
                createDetails: WebExtension.CreateTabDetails,
            ): GeckoResult<GeckoSession> {
                val rawUrl = createDetails.url
                val url = rawUrl ?: "about:blank"
                val isOwnExt = ownExtensionBaseUrl != null && url.startsWith(ownExtensionBaseUrl!!, ignoreCase = true)
                val isBlank = rawUrl.isNullOrBlank() || url.equals("about:blank", ignoreCase = true)
                val parsedUri = try { Uri.parse(url) } catch (_: Exception) { null }
                val host = parsedUri
                    ?.takeIf { it.scheme.equals("https", ignoreCase = true) }
                    ?.host?.lowercase()?.trimEnd('.')
                val targetCompartment = when {
                    isOwnExt || isBlank -> Compartment.EXTENSION
                    host == "chat.xmr.club" -> Compartment.CHAT
                    host == "x.com" || host == "www.x.com" || host == "mobile.x.com" ||
                        host == "twitter.com" || host == "www.twitter.com" || host == "mobile.twitter.com" -> Compartment.X
                    else -> Compartment.SWAP
                }
                val shouldFocus = createDetails.active != false
                Log.i(TAG, "onNewTab: url=$url active=${createDetails.active} shouldFocus=$shouldFocus compartment=$targetCompartment")
                // GeckoView requires TabDelegate.onNewTab to return an UNOPENED GeckoSession;
                // GeckoView opens it and loads createDetails.url itself (calling open() before
                // returning makes browser.tabs.create() reject with "tabs.create is not supported").
                val entry = createTab(
                    compartment = targetCompartment,
                    openImmediately = shouldFocus,
                    preOpenSession = false,
                )
                if (targetCompartment == Compartment.SWAP) {
                    NavigationPolicy.normalizeUserSwapInput(url)?.second?.let { entry.allowedSwapHosts.add(it) }
                }
                return GeckoResult.fromValue(entry.session)
            }
        }

        ext.setActionDelegate(object : WebExtension.ActionDelegate {
            override fun onBrowserAction(
                source: WebExtension,
                session: GeckoSession?,
                action: WebExtension.Action,
            ) {
                runOnUiThread {
                    badgeText = action.badgeText?.takeIf { it.isNotBlank() }
                    updateNavHighlight()
                }
            }

            override fun onOpenPopup(
                source: WebExtension,
                action: WebExtension.Action,
            ): GeckoResult<GeckoSession> {
                val entry = createTab(
                    compartment = Compartment.EXTENSION,
                    openImmediately = true,
                    preOpenSession = false,
                )
                return GeckoResult.fromValue(entry.session)
            }
        })

        // Native Android NIP-55 signer bridge — restricted strictly to our own background script
        // (ENV_TYPE_EXTENSION + session == null blocks content scripts and visible extension pages).
        ext.setMessageDelegate(
            object : WebExtension.MessageDelegate {
                override fun onMessage(
                    nativeApp: String,
                    message: Any,
                    sender: WebExtension.MessageSender,
                ): GeckoResult<Any> {
                    if (nativeApp != Nip55Bridge.NATIVE_APP_ID ||
                        sender.webExtension.id != EXT_ID ||
                        sender.environmentType != WebExtension.MessageSender.ENV_TYPE_EXTENSION ||
                        sender.session != null
                    ) {
                        Log.w(
                            TAG,
                            "Rejected native message: app=$nativeApp ext=${sender.webExtension.id} env=${sender.environmentType} hasSession=${sender.session != null}",
                        )
                        return GeckoResult.fromValue(nativeReply(JSONObject().put("error", "Not allowed")))
                    }
                    val obj = when (message) {
                        is JSONObject -> message
                        is String -> try { JSONObject(message) } catch (_: Exception) { null }
                        else -> null
                    } ?: return GeckoResult.fromValue(nativeReply(JSONObject().put("error", "Invalid message payload")))
                    return handleNativeSignerMessage(obj)
                }
            },
            Nip55Bridge.NATIVE_APP_ID,
        )

        // Re-bind SessionTabDelegate on any already-open sessions whenever the extension reloads.
        for (t in tabs) {
            bindSessionTabDelegate(t.session, ext)
        }
    }

    /**
     * GeckoView's EventCallback rejects raw `org.json.JSONObject` (throwing "Invalid event data for callback")
     * and `GeckoBundle` cannot serialize nested `string[][]` Nostr event tags. Encode replies as JSON strings.
     */
    private fun nativeReply(obj: JSONObject): Any = obj.toString()

    private fun findNip55Signers(): List<SignerAppInfo> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
        val resolved = packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        val seen = LinkedHashSet<String>()
        val out = mutableListOf<SignerAppInfo>()
        for (ri in resolved) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (pkg == packageName || !seen.add(pkg)) continue
            val label = ri.loadLabel(packageManager).toString().takeIf { it.isNotBlank() } ?: pkg
            out.add(SignerAppInfo(packageName = pkg, label = label))
        }
        return out
    }

    private fun validPinnedSignerPackage(signers: List<SignerAppInfo>): String? {
        val saved = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_SIGNER_PKG, null) ?: return null
        return signers.firstOrNull { it.packageName == saved }?.packageName
    }

    private fun savePinnedSignerPackage(pkg: String?) {
        val editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
        if (pkg.isNullOrBlank()) editor.remove(PREF_SIGNER_PKG) else editor.putString(PREF_SIGNER_PKG, pkg)
        editor.apply()
    }

    private fun pickSignerPackage(signers: List<SignerAppInfo>, allowPinned: Boolean, onChosen: (String?) -> Unit) {
        if (signers.isEmpty()) {
            onChosen(null)
            return
        }
        if (allowPinned) {
            validPinnedSignerPackage(signers)?.let { pinned ->
                onChosen(pinned)
                return
            }
        }
        if (signers.size == 1) {
            onChosen(signers[0].packageName)
            return
        }
        if (isFinishing || isDestroyed || signerPickerInFlight) {
            onChosen(null)
            return
        }
        signerPickerInFlight = true
        val done = AtomicBoolean(false)
        val finish: (String?) -> Unit = { pkg ->
            if (done.compareAndSet(false, true)) {
                signerPickerInFlight = false
                onChosen(pkg)
            }
        }
        val labels = signers.map { "${it.label} (${it.packageName})" }.toTypedArray()
        val dlg = AlertDialog.Builder(this)
            .setTitle("Choose Nostr signer")
            .setItems(labels) { _, which -> finish(signers[which].packageName) }
            .setNegativeButton(R.string.cancel) { _, _ -> finish(null) }
            .setOnCancelListener { finish(null) }
            .create()
        if (!showTrackedDialog(dlg) { finish(null) }) {
            finish(null)
        }
    }

    private fun handleNativeSignerMessage(msg: JSONObject): GeckoResult<Any> {
        return when (msg.optString("type")) {
            "probe" -> {
                val signers = findNip55Signers()
                val res = JSONObject()
                    .put("androidApp", true)
                    .put("nip55Available", signers.isNotEmpty())
                validPinnedSignerPackage(signers)?.let { res.put("signerPackage", it) }
                GeckoResult.fromValue(nativeReply(res))
            }
            "clear_signer" -> {
                savePinnedSignerPackage(null)
                GeckoResult.fromValue(nativeReply(JSONObject().put("ok", true)))
            }
            "cancel_signer" -> {
                runOnUiThread { cancelPendingNip55Request() }
                GeckoResult.fromValue(nativeReply(JSONObject().put("ok", true)))
            }
            "get_public_key" -> handleNip55GetPublicKey()
            "sign_event" -> handleNip55SignEvent(msg)
            else -> GeckoResult.fromValue(nativeReply(JSONObject().put("error", "Unknown native signer action")))
        }
    }

    private fun queryNip55GetPublicKeyContentResolver(targetPkg: String): String? {
        val uri = Uri.parse("content://$targetPkg.GET_PUBLIC_KEY")
        return try {
            val cursor = contentResolver.query(uri, arrayOf("login"), null, null, null) ?: return null
            cursor.use { c ->
                if (!c.moveToFirst()) return null
                val rejectedIdx = c.getColumnIndex("rejected")
                if (rejectedIdx >= 0) {
                    val rejVal = c.getString(rejectedIdx)
                    if (rejVal == null || rejVal.equals("true", ignoreCase = true) || rejVal == "1" || rejVal.isEmpty()) {
                        return null
                    }
                }
                val resultIdx = c.getColumnIndex("result")
                val sigIdx = c.getColumnIndex("signature")
                val rawKey = when {
                    resultIdx >= 0 -> c.getString(resultIdx)
                    sigIdx >= 0 -> c.getString(sigIdx)
                    else -> null
                }
                Nip55Bridge.normalizePubkey(rawKey)
            }
        } catch (e: Exception) {
            Log.d(TAG, "NIP-55 GET_PUBLIC_KEY ContentResolver unavailable ($targetPkg): ${e.message}")
            null
        }
    }

    private fun handleNip55GetPublicKey(): GeckoResult<Any> {
        val signers = findNip55Signers()
        if (signers.isEmpty()) {
            return GeckoResult.fromValue(
                nativeReply(
                    JSONObject()
                        .put("noSigner", true)
                        .put("error", "No Android Nostr signer found (install Amber)"),
                ),
            )
        }
        val result = GeckoResult<Any>()
        val launchInteractive = {
            runOnUiThread {
                if (isFinishing || isDestroyed) {
                    result.complete(nativeReply(JSONObject().put("error", "App is closing")))
                    return@runOnUiThread
                }
                if (pendingNip55Callback != null) {
                    result.complete(nativeReply(JSONObject().put("error", "Another signer request is already open")))
                    return@runOnUiThread
                }
                pickSignerPackage(signers, allowPinned = false) { chosenPkg ->
                    if (chosenPkg == null) {
                        result.complete(nativeReply(JSONObject().put("error", "Signer selection cancelled")))
                        return@pickSignerPackage
                    }
                    if (pendingNip55Callback != null) {
                        result.complete(nativeReply(JSONObject().put("error", "Another signer request is already open")))
                        return@pickSignerPackage
                    }
                    armPendingNip55Callback { resultCode, data ->
                        val rejected = data?.getBooleanExtra("rejected", false) == true
                        if (resultCode != Activity.RESULT_OK || rejected) {
                            result.complete(nativeReply(JSONObject().put("error", "Signer request was cancelled or rejected")))
                        } else {
                            val rawKey = data?.getStringExtra("result") ?: data?.getStringExtra("signature")
                            val hex = Nip55Bridge.normalizePubkey(rawKey)
                            if (hex == null) {
                                result.complete(nativeReply(JSONObject().put("error", "Signer returned an invalid public key")))
                            } else {
                                // Pin the package we explicitly launched, never trusting an echoed package extra.
                                savePinnedSignerPackage(chosenPkg)
                                result.complete(nativeReply(JSONObject().put("pubkey", hex).put("package", chosenPkg)))
                            }
                        }
                    }
                    try {
                        nip55Launcher.launch(Nip55Bridge.buildGetPublicKeyIntent(chosenPkg))
                    } catch (e: Exception) {
                        cancelPendingNip55Timeout()
                        pendingNip55Callback = null
                        Log.w(TAG, "Failed launching NIP-55 get_public_key ($chosenPkg)", e)
                        result.complete(nativeReply(JSONObject().put("error", "Could not open Nostr signer app")))
                    }
                }
            }
        }

        val pinned = validPinnedSignerPackage(signers)
        if (pinned != null) {
            runOnNip55(
                onRejected = { result.complete(nativeReply(JSONObject().put("error", "App is closing"))) },
            ) {
                val hex = queryNip55GetPublicKeyContentResolver(pinned)
                if (hex != null) {
                    result.complete(nativeReply(JSONObject().put("pubkey", hex).put("package", pinned)))
                } else {
                    launchInteractive()
                }
            }
        } else {
            launchInteractive()
        }
        return result
    }

    private fun handleNip55SignEvent(msg: JSONObject): GeckoResult<Any> {
        val eventObj = msg.optJSONObject("event") ?: msg.optString("eventJson", "").takeIf { it.isNotBlank() }?.let {
            try { JSONObject(it) } catch (_: Exception) { null }
        }
        val req = Nip55Bridge.validateSignEventRequest(eventObj, msg.optString("pubkey", ""))
            ?: return GeckoResult.fromValue(nativeReply(JSONObject().put("error", "Disallowed or invalid Nostr event")))

        val signers = findNip55Signers()
        if (signers.isEmpty()) {
            return GeckoResult.fromValue(
                nativeReply(
                    JSONObject()
                        .put("noSigner", true)
                        .put("error", "No Android Nostr signer found (install Amber)"),
                ),
            )
        }

        val quiet = msg.optBoolean("quiet", false)
        val result = GeckoResult<Any>()
        val launchInteractive: (String) -> Unit = { targetPkg ->
            runOnUiThread {
                if (isFinishing || isDestroyed) {
                    result.complete(nativeReply(JSONObject().put("error", "App is closing")))
                    return@runOnUiThread
                }
                if (pendingNip55Callback != null) {
                    result.complete(nativeReply(JSONObject().put("error", "Another signer request is already open")))
                    return@runOnUiThread
                }
                val reqId = UUID.randomUUID().toString()
                armPendingNip55Callback { resultCode, data ->
                    val rejected = data?.getBooleanExtra("rejected", false) == true
                    if (resultCode != Activity.RESULT_OK && !rejected) {
                        result.complete(nativeReply(JSONObject().put("error", "Signing was cancelled in signer app")))
                    } else {
                        val parsed = Nip55Bridge.parseSignResponse(
                            eventJsonStr = data?.getStringExtra("event"),
                            resultStr = data?.getStringExtra("result") ?: data?.getStringExtra("signature"),
                            expectedId = reqId,
                            returnedId = data?.getStringExtra("id"),
                            rejected = rejected,
                        )
                        when (parsed) {
                            is Nip55Bridge.ParsedSignResponse.SignedEvent -> {
                                savePinnedSignerPackage(targetPkg)
                                result.complete(nativeReply(JSONObject().put("event", parsed.event)))
                            }
                            is Nip55Bridge.ParsedSignResponse.SignatureOnly -> {
                                savePinnedSignerPackage(targetPkg)
                                result.complete(nativeReply(JSONObject().put("sig", parsed.sigHex)))
                            }
                            is Nip55Bridge.ParsedSignResponse.Rejected -> {
                                result.complete(nativeReply(JSONObject().put("error", parsed.reason)))
                            }
                            Nip55Bridge.ParsedSignResponse.Empty -> {
                                result.complete(nativeReply(JSONObject().put("error", "Signer did not return a signed event")))
                            }
                        }
                    }
                }
                try {
                    nip55Launcher.launch(
                        Nip55Bridge.buildSignEventIntent(targetPkg, req.canonicalEventJson, req.pubkeyHex, reqId),
                    )
                } catch (e: Exception) {
                    cancelPendingNip55Timeout()
                    pendingNip55Callback = null
                    Log.w(TAG, "Failed launching NIP-55 sign_event ($targetPkg)", e)
                    result.complete(nativeReply(JSONObject().put("error", "Could not open Nostr signer app")))
                }
            }
        }

        val tryBackgroundThenInteractive: (String) -> Unit = { targetPkg ->
            if (req.requiresInteractive) {
                // Public posts and articles (kinds 1, 30023) always require explicit interactive approval in Amber.
                launchInteractive(targetPkg)
            } else {
                runOnNip55(
                    onRejected = { result.complete(nativeReply(JSONObject().put("error", "App is closing"))) },
                ) {
                    val bgParsed = queryNip55SignEventContentResolver(targetPkg, req)
                    when (bgParsed) {
                        is Nip55Bridge.ParsedSignResponse.SignedEvent -> {
                            result.complete(nativeReply(JSONObject().put("event", bgParsed.event)))
                        }
                        is Nip55Bridge.ParsedSignResponse.SignatureOnly -> {
                            result.complete(nativeReply(JSONObject().put("sig", bgParsed.sigHex)))
                        }
                        is Nip55Bridge.ParsedSignResponse.Rejected -> {
                            // Never fall back to an interactive popup when the user already denied this kind.
                            result.complete(nativeReply(JSONObject().put("error", bgParsed.reason)))
                        }
                        Nip55Bridge.ParsedSignResponse.Empty -> {
                            if (quiet) {
                                // Quiet requests (e.g. background xo) never pop Amber unexpectedly; surface
                                // an explicit error so the user can grant background permission in their signer.
                                result.complete(
                                    nativeReply(
                                        JSONObject()
                                            .put("backgroundPermissionMissing", true)
                                            .put("error", "Background signing not approved in your Nostr signer (approve XMRadar in Amber or reconnect in Options)"),
                                    ),
                                )
                            } else {
                                launchInteractive(targetPkg)
                            }
                        }
                    }
                }
            }
        }

        val pinned = validPinnedSignerPackage(signers)
        if (pinned != null) {
            tryBackgroundThenInteractive(pinned)
        } else {
            runOnUiThread {
                pickSignerPackage(signers, allowPinned = true) { chosenPkg ->
                    if (chosenPkg == null) {
                        result.complete(nativeReply(JSONObject().put("error", "Signer selection cancelled")))
                    } else {
                        tryBackgroundThenInteractive(chosenPkg)
                    }
                }
            }
        }
        return result
    }

    private fun queryNip55SignEventContentResolver(
        targetPkg: String,
        req: Nip55Bridge.ValidatedSignRequest,
    ): Nip55Bridge.ParsedSignResponse {
        val uri = Uri.parse("content://$targetPkg.SIGN_EVENT")
        return try {
            val cursor = contentResolver.query(
                uri,
                arrayOf(req.canonicalEventJson, "", req.pubkeyHex),
                null,
                null,
                null,
            ) ?: return Nip55Bridge.ParsedSignResponse.Empty
            cursor.use { c ->
                if (!c.moveToFirst()) return Nip55Bridge.ParsedSignResponse.Empty
                val rejectedIdx = c.getColumnIndex("rejected")
                if (rejectedIdx >= 0) {
                    val rejVal = c.getString(rejectedIdx)
                    if (rejVal == null || rejVal.equals("true", ignoreCase = true) || rejVal == "1" || rejVal.isEmpty()) {
                        return Nip55Bridge.ParsedSignResponse.Rejected("Signer rejected this request")
                    }
                }
                val eventIdx = c.getColumnIndex("event")
                val resultIdx = c.getColumnIndex("result")
                val sigIdx = c.getColumnIndex("signature")
                val eventStr = if (eventIdx >= 0) c.getString(eventIdx) else null
                val resultStr = when {
                    resultIdx >= 0 -> c.getString(resultIdx)
                    sigIdx >= 0 -> c.getString(sigIdx)
                    else -> null
                }
                Nip55Bridge.parseSignResponse(
                    eventJsonStr = eventStr,
                    resultStr = resultStr,
                    expectedId = null,
                    returnedId = null,
                    rejected = false,
                )
            }
        } catch (e: SecurityException) {
            Log.d(TAG, "NIP-55 ContentResolver permission not granted ($targetPkg): ${e.message}")
            Nip55Bridge.ParsedSignResponse.Empty
        } catch (e: IllegalArgumentException) {
            Log.d(TAG, "NIP-55 ContentResolver unavailable ($targetPkg): ${e.message}")
            Nip55Bridge.ParsedSignResponse.Empty
        } catch (e: IllegalStateException) {
            Log.d(TAG, "NIP-55 ContentResolver state error ($targetPkg): ${e.message}")
            Nip55Bridge.ParsedSignResponse.Empty
        } catch (e: Exception) {
            Log.w(TAG, "NIP-55 ContentResolver failed ($targetPkg)", e)
            Nip55Bridge.ParsedSignResponse.Empty
        }
    }

    private fun openOrFocusCompartment(compartment: Compartment, defaultUrl: String) {
        val existing = tabs.lastOrNull { it.compartment == compartment }
        if (existing != null) {
            focusTab(existing)
            return
        }
        val entry = createTab(compartment, openImmediately = true)
        entry.session.loadUri(defaultUrl)
    }

    private fun openExtensionUi(page: String) {
        val base = ownExtensionBaseUrl
        if (base == null) {
            Toast.makeText(this, R.string.ext_loading, Toast.LENGTH_SHORT).show()
            return
        }
        // Keep a clean extension session for popup/options so X stays alive in memory.
        val existing = tabs.lastOrNull { it.compartment == Compartment.EXTENSION }
        val entry = existing ?: createTab(Compartment.EXTENSION, openImmediately = true)
        focusTab(entry)
        val siteUrl = lastSiteTab?.currentUrl?.takeIf { it.startsWith("https://", ignoreCase = true) }
        val targetUrl = if (page == "popup.html" && siteUrl != null) {
            "$base$page?siteUrl=${Uri.encode(siteUrl)}"
        } else {
            "$base$page"
        }
        entry.session.loadUri(targetUrl)
    }

    private fun showSwapUrlDialog() {
        if (isFinishing || isDestroyed) return
        if (!privateBrowsingReady) {
            val rt = runtime
            val ext = extension
            val dlg = AlertDialog.Builder(this)
                .setTitle("Swap Guard unavailable")
                .setMessage("XMRadar could not enable its extension inside private Swap tabs. Retry before visiting a swap site.")
                .setPositiveButton("Retry") { _, _ ->
                    if (rt != null && ext != null) {
                        rt.webExtensionController.setAllowedInPrivateBrowsing(ext, true).accept(
                            { updated ->
                                if (updated != null) {
                                    extension = updated
                                    sharedExtension = updated
                                    ownExtensionBaseUrl = updated.metaData.baseUrl
                                    sharedExtensionBaseUrl = updated.metaData.baseUrl
                                    attachExtensionDelegates(updated)
                                }
                                privateBrowsingReady = true
                                sharedPrivateBrowsingReady = true
                                runOnUiThread {
                                    if (!isFinishing && !isDestroyed) showSwapUrlDialog()
                                }
                            },
                            {
                                runOnUiThread {
                                    if (!isFinishing && !isDestroyed) {
                                        Toast.makeText(this, "Could not enable private Swap Guard.", Toast.LENGTH_LONG).show()
                                    }
                                }
                            }
                        )
                    }
                }
                .setNegativeButton(R.string.cancel, null)
                .create()
            showTrackedDialog(dlg)
            return
        }
        val dialog = BottomSheetDialog(this)
        val view = layoutInflater.inflate(R.layout.dialog_swap, null)
        dialog.setContentView(view)
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.skipCollapsed = true

        val input = view.findViewById<EditText>(R.id.swap_url_input)
        val clearBtn = view.findViewById<TextView>(R.id.swap_url_clear)
        val errorView = view.findViewById<TextView>(R.id.swap_url_error)
        val openBtn = view.findViewById<Button>(R.id.swap_btn_open)
        val cancelBtn = view.findViewById<Button>(R.id.swap_btn_cancel)

        input.setText("kyc.rip")
        input.setSelection(input.text.length)

        fun updateClearVisibility() {
            clearBtn.visibility = if (input.text.isNullOrEmpty()) View.INVISIBLE else View.VISIBLE
        }
        updateClearVisibility()
        input.doAfterTextChanged {
            updateClearVisibility()
            if (errorView.visibility == View.VISIBLE) errorView.visibility = View.GONE
        }
        clearBtn.setOnClickListener {
            input.setText("")
            input.requestFocus()
        }

        val chips = listOf(
            R.id.swap_chip_kycrip to "kyc.rip",
            R.id.swap_chip_xmrclub to "xmr.club",
            R.id.swap_chip_xmrbio to "xmr.bio",
        )
        for ((chipId, host) in chips) {
            view.findViewById<TextView>(chipId).setOnClickListener {
                input.setText(host)
                input.setSelection(host.length)
                errorView.visibility = View.GONE
            }
        }

        fun submit() {
            val normalized = NavigationPolicy.normalizeUserSwapInput(input.text.toString())
            if (normalized == null) {
                errorView.text = getString(R.string.swap_invalid_host)
                errorView.visibility = View.VISIBLE
                return
            }
            dialog.dismiss()
            val (url, host) = normalized
            val entry = createTab(Compartment.SWAP, openImmediately = true)
            entry.allowedSwapHosts.add(host)
            entry.session.loadUri(url)
        }

        openBtn.setOnClickListener { submit() }
        cancelBtn.setOnClickListener { dialog.dismiss() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else {
                false
            }
        }
        if (showTrackedDialog(dialog)) {
            applySheetBottomInsets(view)
        }
    }

    private fun createTab(
        compartment: Compartment,
        openImmediately: Boolean,
        preOpenSession: Boolean = true,
    ): TabEntry {
        val rt = requireNotNull(runtime) { "GeckoRuntime not initialized" }
        val settingsBuilder = GeckoSessionSettings.Builder()
            .useTrackingProtection(true)

        when (compartment) {
            Compartment.X -> settingsBuilder
                .contextId("x")
                .displayMode(GeckoSessionSettings.DISPLAY_MODE_STANDALONE)
            Compartment.CHAT -> settingsBuilder
                .contextId("chat")
                .displayMode(GeckoSessionSettings.DISPLAY_MODE_STANDALONE)
            Compartment.SWAP -> settingsBuilder.usePrivateMode(true)
            // Extension pages use GeckoView's default context so they share IndexedDB & browser.storage
            // cleanly with the background script.
            Compartment.EXTENSION -> {}
        }

        val session = GeckoSession(settingsBuilder.build())
        val entry = TabEntry(id = sharedNextTabId++, compartment = compartment, session = session)
        wireSessionDelegates(entry)
        if (preOpenSession) {
            session.open(rt)
        }
        tabs.add(entry)
        if (openImmediately) {
            if (preOpenSession) {
                focusTab(entry)
            } else {
                // GeckoView opens sessions returned by onNewTab / onOpenPopup / onNewSession
                // asynchronously AFTER the delegate returns. Attaching an unopened session to
                // GeckoView leaves a blank display surface; defer focusTab until session.isOpen.
                entry.pendingFocus = true
                geckoView.post { promotePendingFocus(entry) }
            }
        }
        return entry
    }

    private fun promotePendingFocus(entry: TabEntry) {
        if (!entry.pendingFocus) return
        if (entry !in tabs) {
            entry.pendingFocus = false
            return
        }
        if (entry.session.isOpen) {
            entry.pendingFocus = false
            focusTab(entry)
        }
    }

    private fun wireSessionDelegates(entry: TabEntry) {
        val session = entry.session

        session.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean,
            ) {
                entry.currentUrl = url ?: ""
                if (entry.compartment == Compartment.X) {
                    if (NavigationPolicy.isXAuthUrl(url)) {
                        entry.inXAuthFlowUntilMs = System.currentTimeMillis() + X_AUTH_FLOW_TTL_MS
                    } else if (NavigationPolicy.isXNonAuthUrl(url)) {
                        entry.inXAuthFlowUntilMs = 0L
                    }
                }
                runOnUiThread {
                    promotePendingFocus(entry)
                    if (activeTab == entry) updateNavHighlight()
                }
            }

            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                entry.canGoBack = canGoBack
            }

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest,
            ): GeckoResult<AllowOrDeny> {
                val decision = NavigationPolicy.evaluate(
                    rawUrl = request.uri,
                    compartment = entry.compartment,
                    ownExtensionBaseUrl = ownExtensionBaseUrl,
                    hasUserGesture = request.hasUserGesture,
                    isRedirect = request.isRedirect,
                    inXAuthFlow = entry.isAuthFlowActive(),
                    userAllowedSwapHosts = entry.allowedSwapHosts,
                )
                // Handle one-shot external HTTPS redirects from a user-tapped child tab (e.g.
                // X composer's Grok icon -> x.com/i/grok -> 302 https://grok.com/...): hand off to
                // the external browser and close the empty child tab so the user isn't stranded.
                val recentChildTap = entry.openedByUserTapAtMs > 0L &&
                    (SystemClock.uptimeMillis() - entry.openedByUserTapAtMs) <= 5_000L
                if (decision is Decision.Deny && recentChildTap && tabs.size > 1) {
                    val externalCheck = NavigationPolicy.evaluate(
                        rawUrl = request.uri,
                        compartment = entry.compartment,
                        ownExtensionBaseUrl = ownExtensionBaseUrl,
                        hasUserGesture = true,
                        isRedirect = false,
                        inXAuthFlow = entry.isAuthFlowActive(),
                        userAllowedSwapHosts = entry.allowedSwapHosts,
                    )
                    if (externalCheck is Decision.OpenExternalBrowser) {
                        entry.openedByUserTapAtMs = 0L
                        runOnUiThread {
                            openExternalIntent(Uri.parse(externalCheck.url), R.string.external_no_browser)
                            if (entry in tabs && tabs.size > 1) {
                                closeTab(entry)
                            }
                        }
                        return GeckoResult.fromValue(AllowOrDeny.DENY)
                    }
                }
                return handleDecision(decision, request.uri)
            }

            override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession> {
                // Consume a single real Android OS touch-up gesture (<= 1.5s old) so user-clicked
                // target="_blank" / t.co external links hand off to Vanadium while script-driven
                // window.open() popups without a real tap remain blocked.
                val hasRealTouch = consumeRecentTouchGesture()
                val decision = NavigationPolicy.evaluate(
                    rawUrl = uri,
                    compartment = entry.compartment,
                    ownExtensionBaseUrl = ownExtensionBaseUrl,
                    hasUserGesture = hasRealTouch,
                    isRedirect = false,
                    inXAuthFlow = entry.isAuthFlowActive(),
                    userAllowedSwapHosts = entry.allowedSwapHosts,
                )
                return when (decision) {
                    Decision.AllowInApp -> {
                        val result = GeckoResult<GeckoSession>()
                        runOnUiThread {
                            // NavigationDelegate.onNewSession also requires an unopened GeckoSession.
                            val child = createTab(
                                compartment = entry.compartment,
                                openImmediately = true,
                                preOpenSession = false,
                            )
                            child.inXAuthFlowUntilMs = entry.inXAuthFlowUntilMs
                            child.allowedSwapHosts.addAll(entry.allowedSwapHosts)
                            if (hasRealTouch) {
                                child.openedByUserTapAtMs = SystemClock.uptimeMillis()
                            }
                            result.complete(child.session)
                        }
                        result
                    }
                    is Decision.OpenExternalBrowser,
                    is Decision.ConfirmMoneroUri,
                    is Decision.OpenMailto -> {
                        handleDecision(decision, uri)
                        GeckoResult.fromValue(null)
                    }
                    is Decision.Deny -> {
                        Log.w(TAG, "Blocked onNewSession ($uri): ${decision.reason}")
                        GeckoResult.fromValue(null)
                    }
                }
            }
        }

        session.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                runOnUiThread {
                    promotePendingFocus(entry)
                }
            }

            override fun onProgressChange(session: GeckoSession, progress: Int) {
                runOnUiThread {
                    promotePendingFocus(entry)
                    if (activeTab?.session != session) return@runOnUiThread
                    progressBar.visibility = if (progress in 1..99) View.VISIBLE else View.GONE
                    progressBar.progress = progress
                }
            }

            override fun onSessionStateChange(
                session: GeckoSession,
                sessionState: GeckoSession.SessionState,
            ) {
                entry.lastSessionState = sessionState
            }
        }

        session.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onCloseRequest(session: GeckoSession) {
                runOnUiThread {
                    val target = tabs.firstOrNull { it.session == session } ?: return@runOnUiThread
                    closeTab(target)
                }
            }

            override fun onKill(session: GeckoSession) {
                Log.w(TAG, "Content process killed for tab ${entry.id} (${entry.compartment})")
                runOnUiThread {
                    entry.needsRecovery = true
                    if (!activityStopped && activeTab == entry) {
                        recoverTab(entry)
                    }
                }
            }

            override fun onCrash(session: GeckoSession) {
                Log.w(TAG, "Content process crashed for tab ${entry.id} (${entry.compartment})")
                runOnUiThread {
                    entry.needsRecovery = true
                    if (!activityStopped && activeTab == entry) {
                        recoverTab(entry)
                    }
                }
            }

            override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
                // Supports SIWM "Save message as file" and receipt/letter JSON exports off the main thread.
                val body = response.body ?: return
                val disposition = response.headers["Content-Disposition"] ?: response.headers["content-disposition"]
                val suggestedName = Regex("filename=\"?([^\";]+)\"?").find(disposition ?: "")?.groupValues?.getOrNull(1)
                    ?: "xmradar-export.txt"
                if (isFinishing || isDestroyed || downloadExecutor.isShutdown) {
                    try { body.close() } catch (_: Exception) {}
                    return
                }
                try {
                    downloadExecutor.execute {
                        val bytes = try {
                            body.use { stream ->
                                val out = ByteArrayOutputStream()
                                val buf = ByteArray(8192)
                                var total = 0
                                while (true) {
                                    val n = stream.read(buf)
                                    if (n < 0) break
                                    total += n
                                    if (total > MAX_DOWNLOAD_BYTES) {
                                        Log.w(TAG, "Refused download larger than $MAX_DOWNLOAD_BYTES bytes")
                                        return@use null
                                    }
                                    out.write(buf, 0, n)
                                }
                                out.toByteArray()
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed reading download response", e)
                            null
                        }
                        runOnUiThread {
                            if (isFinishing || isDestroyed) return@runOnUiThread
                            if (bytes == null) {
                                Toast.makeText(this@MainActivity, "Download failed or too large", Toast.LENGTH_SHORT).show()
                                return@runOnUiThread
                            }
                            pendingDownloadBytes = bytes
                            try {
                                createDocumentLauncher.launch(suggestedName)
                            } catch (e: ActivityNotFoundException) {
                                pendingDownloadBytes = null
                                Log.w(TAG, "No document picker available", e)
                                Toast.makeText(this@MainActivity, "Could not open file saver", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    try { body.close() } catch (_: Exception) {}
                }
            }
        }

        session.promptDelegate = object : GeckoSession.PromptDelegate {
            override fun onAlertPrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.AlertPrompt,
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                val finish = completeOnce(result)
                runOnUiThread {
                    if (isFinishing || isDestroyed) {
                        finish(prompt.dismiss())
                        return@runOnUiThread
                    }
                    val dlg = AlertDialog.Builder(this@MainActivity)
                        .setTitle(prompt.title ?: getString(R.string.app_name))
                        .setMessage(prompt.message ?: "")
                        .setPositiveButton(android.R.string.ok) { _, _ -> finish(prompt.dismiss()) }
                        .setOnCancelListener { finish(prompt.dismiss()) }
                        .create()
                    if (!showTrackedDialog(dlg) { finish(prompt.dismiss()) }) {
                        finish(prompt.dismiss())
                    }
                }
                return result
            }

            override fun onButtonPrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.ButtonPrompt,
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                val finish = completeOnce(result)
                runOnUiThread {
                    if (isFinishing || isDestroyed) {
                        finish(prompt.dismiss())
                        return@runOnUiThread
                    }
                    val dlg = AlertDialog.Builder(this@MainActivity)
                        .setTitle(prompt.title ?: getString(R.string.app_name))
                        .setMessage(prompt.message ?: "")
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            finish(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.POSITIVE))
                        }
                        .setNegativeButton(android.R.string.cancel) { _, _ ->
                            finish(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.NEGATIVE))
                        }
                        .setOnCancelListener { finish(prompt.dismiss()) }
                        .create()
                    if (!showTrackedDialog(dlg) { finish(prompt.dismiss()) }) {
                        finish(prompt.dismiss())
                    }
                }
                return result
            }

            override fun onTextPrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.TextPrompt,
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                val finish = completeOnce(result)
                runOnUiThread {
                    if (isFinishing || isDestroyed) {
                        finish(prompt.dismiss())
                        return@runOnUiThread
                    }
                    val input = EditText(this@MainActivity).apply {
                        setText(prompt.defaultValue ?: "")
                    }
                    val dlg = AlertDialog.Builder(this@MainActivity)
                        .setTitle(prompt.title ?: getString(R.string.app_name))
                        .setMessage(prompt.message ?: "")
                        .setView(input)
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            finish(prompt.confirm(input.text.toString()))
                        }
                        .setNegativeButton(android.R.string.cancel) { _, _ ->
                            finish(prompt.dismiss())
                        }
                        .setOnCancelListener { finish(prompt.dismiss()) }
                        .create()
                    if (!showTrackedDialog(dlg) { finish(prompt.dismiss()) }) {
                        finish(prompt.dismiss())
                    }
                }
                return result
            }

            override fun onChoicePrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.ChoicePrompt,
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                val finish = completeOnce(result)
                val choices = prompt.choices
                val labels = choices.map { it.label }.toTypedArray()
                runOnUiThread {
                    if (isFinishing || isDestroyed) {
                        finish(prompt.dismiss())
                        return@runOnUiThread
                    }
                    val dlg = AlertDialog.Builder(this@MainActivity)
                        .setTitle(prompt.title ?: getString(R.string.app_name))
                        .setItems(labels) { _, which ->
                            finish(prompt.confirm(choices[which]))
                        }
                        .setOnCancelListener { finish(prompt.dismiss()) }
                        .create()
                    if (!showTrackedDialog(dlg) { finish(prompt.dismiss()) }) {
                        finish(prompt.dismiss())
                    }
                }
                return result
            }

            override fun onFilePrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.FilePrompt,
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                val finish = completeOnce(result)
                val mime = prompt.mimeTypes?.firstOrNull()?.takeIf { it.isNotBlank() } ?: "*/*"
                runOnUiThread {
                    if (isFinishing || isDestroyed) {
                        finish(prompt.dismiss())
                        return@runOnUiThread
                    }
                    // Dismiss any prior unresolved file prompt before replacing the callback.
                    pendingFileCallback?.invoke(null)
                    pendingFileCallback = { uri ->
                        if (uri != null) {
                            finish(prompt.confirm(this@MainActivity, uri))
                        } else {
                            finish(prompt.dismiss())
                        }
                    }
                    try {
                        filePickerLauncher.launch(mime)
                    } catch (e: ActivityNotFoundException) {
                        pendingFileCallback = null
                        Log.w(TAG, "No file picker available", e)
                        finish(prompt.dismiss())
                    }
                }
                return result
            }
        }

        session.permissionDelegate = object : GeckoSession.PermissionDelegate {
            override fun onContentPermissionRequest(
                session: GeckoSession,
                perm: GeckoSession.PermissionDelegate.ContentPermission,
            ): GeckoResult<Int> {
                if (perm.permission == GeckoSession.PermissionDelegate.PERMISSION_DESKTOP_NOTIFICATION) {
                    return handleNotificationPermissionRequest(perm)
                }
                // Default-deny geolocation, autoplay, camera, microphone, etc. from web pages.
                return GeckoResult.fromValue(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
            }

            override fun onAndroidPermissionsRequest(
                session: GeckoSession,
                permissions: Array<out String>?,
                callback: GeckoSession.PermissionDelegate.Callback,
            ) {
                callback.reject()
            }
        }

        extension?.let { ext ->
            bindSessionTabDelegate(session, ext)
        }
    }

    private fun handleNotificationPermissionRequest(
        perm: GeckoSession.PermissionDelegate.ContentPermission,
    ): GeckoResult<Int> {
        val deny = GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY
        val allow = GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW
        val originKey = NotificationBridge.allowedPermissionOriginKey(
            rawUri = perm.uri,
            ownExtensionBaseUrl = ownExtensionBaseUrl,
            privateMode = perm.privateMode,
            thirdPartyOrigin = perm.thirdPartyOrigin,
        ) ?: return GeckoResult.fromValue(deny)

        if (originKey.startsWith("moz-extension://", ignoreCase = true)) {
            return GeckoResult.fromValue(if (hasPostNotificationsPermission()) allow else deny)
        }

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val prefKey = PREF_NOTIF_ORIGIN_PREFIX + originKey
        if (prefs.contains(prefKey)) {
            val savedAllow = prefs.getBoolean(prefKey, false)
            return GeckoResult.fromValue(if (savedAllow && hasPostNotificationsPermission()) allow else deny)
        }

        val siteLabel = if (originKey == "https://chat.xmr.club") "XMRadar Chat" else "X"
        val result = GeckoResult<Int>()
        runOnUiThread {
            if (isFinishing || isDestroyed) {
                result.complete(deny)
                return@runOnUiThread
            }
            val queue = pendingOriginNotifResults.getOrPut(originKey) { mutableListOf() }
            val alreadyPrompting = queue.isNotEmpty()
            queue.add(result)
            if (alreadyPrompting) return@runOnUiThread

            val completeAll: (Int) -> Unit = { decision ->
                val waiting = pendingOriginNotifResults.remove(originKey).orEmpty()
                for (r in waiting) r.complete(decision)
            }
            val dlg = AlertDialog.Builder(this)
                .setTitle("Allow $siteLabel notifications?")
                .setMessage("$siteLabel wants to show notifications while XMRadar is running (no Google push / FCM).")
                .setPositiveButton("Allow") { _, _ ->
                    ensurePostNotificationsPermission { granted ->
                        if (granted) {
                            prefs.edit().putBoolean(prefKey, true).apply()
                            completeAll(allow)
                        } else {
                            completeAll(deny)
                        }
                    }
                }
                .setNegativeButton("Block") { _, _ ->
                    prefs.edit().putBoolean(prefKey, false).apply()
                    completeAll(deny)
                }
                .setOnCancelListener { completeAll(deny) }
                .create()
            if (!showTrackedDialog(dlg) { completeAll(deny) }) {
                completeAll(deny)
            }
        }
        return result
    }

    private fun bindSessionTabDelegate(session: GeckoSession, ext: WebExtension) {
        session.webExtensionController.setTabDelegate(ext, object : WebExtension.SessionTabDelegate {
            override fun onCloseTab(
                source: WebExtension?,
                session: GeckoSession,
            ): GeckoResult<AllowOrDeny> {
                runOnUiThread {
                    val target = tabs.firstOrNull { it.session == session }
                    if (target != null) closeTab(target)
                }
                return GeckoResult.fromValue(AllowOrDeny.ALLOW)
            }
        })
    }

    private fun handleDecision(decision: Decision, rawUrl: String): GeckoResult<AllowOrDeny> {
        return when (decision) {
            Decision.AllowInApp -> GeckoResult.fromValue(AllowOrDeny.ALLOW)
            is Decision.ConfirmMoneroUri -> {
                runOnUiThread { showMoneroConfirmation(decision.parsed) }
                GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            is Decision.OpenMailto -> {
                runOnUiThread { openExternalIntent(Uri.parse(decision.uri), R.string.external_no_browser) }
                GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            is Decision.OpenExternalBrowser -> {
                runOnUiThread { openExternalIntent(Uri.parse(decision.url), R.string.external_no_browser) }
                GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            is Decision.Deny -> {
                Log.w(TAG, "Blocked navigation ($rawUrl): ${decision.reason}")
                GeckoResult.fromValue(AllowOrDeny.DENY)
            }
        }
    }

    private fun showMoneroConfirmation(parsed: MoneroUriParser.ParsedMoneroUri) {
        if (isFinishing || isDestroyed) return
        val shortAddr = "${parsed.address.take(12)}…${parsed.address.takeLast(12)}"
        val msg = buildString {
            append("Type: ${parsed.type.name.lowercase()}\n")
            append("Address: $shortAddr\n\n")
            append(parsed.address)
            parsed.amount?.let { append("\n\nAmount: $it XMR") }
            parsed.recipientName?.let { append("\nRecipient: $it") }
            parsed.description?.let { append("\nNote: $it") }
        }
        val dlg = AlertDialog.Builder(this)
            .setTitle(R.string.monero_confirm_title)
            .setMessage(msg)
            .setPositiveButton(R.string.monero_confirm_open) { _, _ ->
                openExternalIntent(Uri.parse(parsed.rawUri), R.string.monero_no_wallet)
            }
            .setNegativeButton(R.string.cancel, null)
            .create()
        showTrackedDialog(dlg)
    }

    private fun openExternalIntent(uri: Uri, missingResId: Int) {
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            startActivity(Intent.createChooser(intent, null))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, missingResId, Toast.LENGTH_LONG).show()
        }
    }

    private fun defaultUrlFor(compartment: Compartment): String? = when (compartment) {
        Compartment.X -> X_HOME_URL
        Compartment.CHAT -> CHAT_URL
        Compartment.SWAP -> SWAP_DEFAULT_URL
        Compartment.EXTENSION -> ownExtensionBaseUrl?.let { "${it}popup.html" }
    }

    private fun attachActiveTabToView(forceNewSurface: Boolean = false) {
        if (activityStopped) return
        val cur = activeTab ?: return
        if (cur !in tabs) return
        val shouldRefreshSurface = forceNewSurface || needsSurfaceRefreshOnResume
        needsSurfaceRefreshOnResume = false
        if (cur.needsRecovery || !cur.session.isOpen) {
            recoverTab(cur)
            if (shouldRefreshSurface) {
                geckoView.requestNewSurface()
            }
            return
        }
        if (geckoView.session !== cur.session) {
            geckoView.setSession(cur.session)
        }
        if (shouldRefreshSurface) {
            // Forces SurfaceView to allocate a fresh Surface/SurfaceControl after lock/unlock
            // without detaching or reloading the live GeckoSession.
            geckoView.requestNewSurface()
        }
        cur.session.setPriorityHint(GeckoSession.PRIORITY_HIGH)
        cur.session.setActive(true)
        cur.session.setFocused(true)
        runtime?.webExtensionController?.setTabActive(cur.session, true)
    }

    private fun recoverTab(entry: TabEntry) {
        if (entry !in tabs) return
        val rt = runtime ?: return
        val now = SystemClock.uptimeMillis()
        if (now - entry.lastRecoveryAtMs < 30_000L) {
            entry.recentRecoveries += 1
        } else {
            entry.recentRecoveries = 1
        }
        entry.lastRecoveryAtMs = now
        if (entry.recentRecoveries > 3) {
            Log.e(TAG, "Skipping recovery loop for tab ${entry.id} (${entry.compartment})")
            return
        }
        entry.needsRecovery = false
        if (!entry.session.isOpen) {
            entry.session.open(rt)
        }
        extension?.let { bindSessionTabDelegate(entry.session, it) }
        val saved = entry.lastSessionState
        if (saved != null) {
            entry.session.restoreState(saved)
        } else {
            val target = entry.currentUrl.takeIf { it.isNotBlank() && !it.equals("about:blank", ignoreCase = true) }
                ?: defaultUrlFor(entry.compartment)
            if (target != null) {
                entry.session.loadUri(target)
            }
        }
        if (activeTab == entry && !activityStopped) {
            if (geckoView.session !== entry.session) {
                geckoView.setSession(entry.session)
            }
            entry.session.setPriorityHint(GeckoSession.PRIORITY_HIGH)
            entry.session.setActive(true)
            entry.session.setFocused(true)
            rt.webExtensionController.setTabActive(entry.session, true)
        }
    }

    private fun focusTab(entry: TabEntry) {
        val prev = activeTab
        if (prev != null && prev != entry) {
            if (prev.session.isOpen) {
                prev.session.setActive(false)
                prev.session.setPriorityHint(GeckoSession.PRIORITY_DEFAULT)
            }
            runtime?.webExtensionController?.setTabActive(prev.session, false)
        }
        activeTab = entry
        if (entry.compartment == Compartment.X || entry.compartment == Compartment.SWAP) {
            lastSiteTab = entry
        }
        attachActiveTabToView()
        progressBar.visibility = View.GONE
        updateSafeAreaChrome(entry.compartment)
        updateNavHighlight()
    }

    private fun closeTab(entry: TabEntry) {
        val wasActive = activeTab == entry
        tabs.remove(entry)
        runtime?.webExtensionController?.setTabActive(entry.session, false)
        entry.session.close()
        // Only switch foreground focus when the closed tab was the active tab; closing a
        // background/replaced tab (e.g. popup.html closing itself right after opening setup.html)
        // must never clobber the newly focused tab.
        if (!wasActive) return
        activeTab = null
        val pending = tabs.lastOrNull { it.pendingFocus }
        if (pending != null) {
            if (pending.session.isOpen) {
                promotePendingFocus(pending)
            }
            return
        }
        val fallback = lastSiteTab?.takeIf { it in tabs }
            ?: tabs.lastOrNull { it.compartment == Compartment.X }
            ?: tabs.lastOrNull()
        if (fallback != null) {
            focusTab(fallback)
        } else {
            openOrFocusCompartment(Compartment.X, X_HOME_URL)
        }
    }

    private fun updateNavHighlight() {
        val badge = badgeText
        if (badge != null) {
            fabBadge.text = badge
            fabBadge.visibility = View.VISIBLE
        } else {
            fabBadge.visibility = View.GONE
        }
    }

    override fun onDestroy() {
        if (currentActivity === this) {
            extension?.let { ext ->
                ext.tabDelegate = null
                ext.setActionDelegate(null)
                ext.setMessageDelegate(null, Nip55Bridge.NATIVE_APP_ID)
            }
            currentActivity = null
        }
        if (screenUnlockReceiverRegistered) {
            try {
                unregisterReceiver(screenUnlockReceiver)
            } catch (_: Exception) {
            }
            screenUnlockReceiverRegistered = false
        }
        cancelPendingNip55Request()
        pendingNotificationTap = null
        pendingDownloadBytes = null
        val staleFileCb = pendingFileCallback
        pendingFileCallback = null
        staleFileCb?.invoke(null)
        for (dlg in activeDialogs.toList()) {
            try {
                dlg.dismiss()
            } catch (_: Exception) {
            }
        }
        activeDialogs.clear()
        if (pendingOriginNotifResults.isNotEmpty()) {
            val deny = GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY
            val allPending = pendingOriginNotifResults.values.flatten()
            pendingOriginNotifResults.clear()
            for (r in allPending) r.complete(deny)
        }
        if (pendingNotifPermCallbacks.isNotEmpty()) {
            val stale = pendingNotifPermCallbacks.toList()
            pendingNotifPermCallbacks.clear()
            notifPermRequestInFlight = false
            for (cb in stale) cb(false)
        }
        nip55Executor.shutdownNow()
        downloadExecutor.shutdownNow()
        geckoView.releaseSession()
        if (isFinishing) {
            for (t in tabs) t.session.close()
            tabs.clear()
            activeTab = null
            lastSiteTab = null
        }
        super.onDestroy()
    }
}

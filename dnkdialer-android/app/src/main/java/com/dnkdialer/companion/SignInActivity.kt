package com.dnkdialer.companion

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.gson.Gson
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Dispatch #28 (2026-05-24) — first-launch sign-in.
 *
 * Posts {email, password} to https://computercaller.com/api/auth/apk-login
 * and stores the returned phoneToken via TokenStore. On success it launches
 * MainActivity and finishes itself so back-button doesn't return here while
 * signed in.
 *
 * MainActivity.onCreate checks TokenStore.hasToken(this) and bounces to this
 * activity if no token is stored. SignOut from MainActivity clears the token
 * and re-launches this activity.
 */
class SignInActivity : AppCompatActivity() {

    companion object {
        private const val LOGIN_URL = "https://computercaller.com/api/auth/apk-login"
        private const val GOOGLE_LOGIN_URL = "https://computercaller.com/api/auth/apk-google-login"
        private const val TAG = "SignInActivity"
    }

    private lateinit var emailField: EditText
    private lateinit var passwordField: EditText
    private lateinit var signInButton: Button
    private lateinit var googleSignInButton: Button
    private lateinit var errorText: TextView

    private val gson = Gson()
    private var inFlight = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_signin)

        // API 35 edge-to-edge: let the surface_base background fill behind the
        // bars and pad the scroll content so the wordmark clears the status
        // bar and the Sign In button / footer clear the gesture nav bar.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        InsetsUtils.applySystemBarInsets(findViewById(R.id.signinContentContainer))

        emailField = findViewById(R.id.emailField)
        passwordField = findViewById(R.id.passwordField)
        signInButton = findViewById(R.id.signInButton)
        googleSignInButton = findViewById(R.id.googleSignInButton)
        errorText = findViewById(R.id.errorText)

        // Clear the error pill as soon as the user starts typing again — the
        // failure was about the previous attempt, not this fresh one.
        val clearOnType = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (errorText.visibility == View.VISIBLE) {
                    errorText.visibility = View.GONE
                }
            }
            override fun afterTextChanged(s: Editable?) {}
        }
        emailField.addTextChangedListener(clearOnType)
        passwordField.addTextChangedListener(clearOnType)

        signInButton.setOnClickListener { attemptSignIn() }
        googleSignInButton.setOnClickListener { attemptGoogleSignIn() }
    }

    /**
     * Sign in with Google (2026-07-06, v43).
     *
     * Credential Manager flow: GetGoogleIdOption with serverClientId set to
     * the WEB OAuth client (BuildConfig.GOOGLE_WEB_CLIENT_ID) so the minted
     * ID token's `aud` matches what /api/auth/apk-google-login verifies.
     * filterByAuthorizedAccounts=false so first-time users see their device
     * accounts (no prior authorization required); autoSelect off so the user
     * always confirms which account signs in.
     */
    private fun attemptGoogleSignIn() {
        if (inFlight) return
        setLoading(true, google = true)

        val option = GetGoogleIdOption.Builder()
            .setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()

        CredentialManager.create(this).getCredentialAsync(
            this,
            request,
            null,
            ContextCompat.getMainExecutor(this),
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val credential = result.credential
                    if (credential is CustomCredential &&
                        credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                    ) {
                        val idToken = try {
                            GoogleIdTokenCredential.createFrom(credential.data).idToken
                        } catch (e: Exception) {
                            android.util.Log.e(TAG, "Google credential parse failed: ${e.javaClass.simpleName}")
                            setLoading(false)
                            showError(getString(R.string.signin_error_generic))
                            return
                        }
                        exchangeGoogleToken(idToken)
                    } else {
                        android.util.Log.w(TAG, "Unexpected credential type: ${credential.type}")
                        setLoading(false)
                        showError(getString(R.string.signin_error_generic))
                    }
                }

                override fun onError(e: GetCredentialException) {
                    setLoading(false)
                    when (e) {
                        // User dismissed the account picker — not an error,
                        // no red pill.
                        is GetCredentialCancellationException -> Unit
                        // No Google account on the device (or Play Services
                        // can't offer one).
                        is NoCredentialException ->
                            showError(getString(R.string.signin_error_google_unavailable))
                        else -> {
                            android.util.Log.w(TAG, "Google credential error: ${e.javaClass.simpleName}")
                            showError(getString(R.string.signin_error_google_unavailable))
                        }
                    }
                }
            }
        )
    }

    /** POST the Google ID token to the backend and reuse the shared login-result path. */
    private fun exchangeGoogleToken(idToken: String) {
        Thread {
            val result = postGoogleLogin(idToken)
            runOnUiThread {
                setLoading(false)
                handleLoginResult(result, google = true)
            }
        }.start()
    }

    private fun attemptSignIn() {
        if (inFlight) return
        val email = emailField.text.toString().trim()
        val password = passwordField.text.toString()

        if (email.isEmpty() || password.isEmpty()) {
            showError(getString(R.string.signin_error_empty))
            return
        }

        setLoading(true)

        // Background HTTP call. HttpURLConnection on a background thread is
        // intentionally low-dependency — we don't want to pull OkHttp in for
        // a single endpoint when the rest of the app already runs java-websocket
        // over its own bundled URL transport.
        Thread {
            val result = postLogin(email, password)
            runOnUiThread {
                setLoading(false)
                handleLoginResult(result, google = false)
            }
        }.start()
    }

    /**
     * Shared post-login handling for both the email/password and Google
     * paths — the backend returns the same {phoneToken, deviceName} shape
     * from both endpoints, so storage + navigation are identical. Only the
     * error copy differs (401/403 mean different things per endpoint).
     */
    private fun handleLoginResult(result: LoginResult, google: Boolean) {
        when (result) {
            is LoginResult.Success -> {
                // Bundle C (audit M12) - TokenStore now throws if the
                // Keystore-backed EncryptedSharedPreferences cannot be
                // opened. Catch and surface a user-facing error rather
                // than appearing to sign in successfully while the
                // token is silently lost.
                try {
                    TokenStore.save(this, result.phoneToken, result.deviceName)
                } catch (e: TokenStore.EncryptedPrefsUnavailableException) {
                    android.util.Log.e(TAG, "Sign-in OK but TokenStore unavailable: ${e.javaClass.simpleName}")
                    showError(getString(R.string.signin_error_generic))
                    return
                }
                if (BuildConfig.DEBUG) {
                    android.util.Log.d(TAG, "Sign-in OK — token stored (${result.phoneToken.take(8)}…)")
                }
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
            is LoginResult.InvalidCredentials -> showError(
                getString(if (google) R.string.signin_error_google_rejected else R.string.signin_error_invalid)
            )
            is LoginResult.Unverified -> showError(
                getString(if (google) R.string.signin_error_google_blocked else R.string.signin_error_unverified)
            )
            is LoginResult.Network -> showError(getString(R.string.signin_error_network))
            is LoginResult.Generic -> showError(getString(R.string.signin_error_generic))
        }
    }

    private fun postLogin(email: String, password: String): LoginResult =
        postAuthRequest(
            LOGIN_URL,
            JSONObject().apply {
                put("email", email)
                put("password", password)
            }.toString()
        )

    /**
     * Google path (v43): POST {idToken} to /api/auth/apk-google-login.
     * Server verifies the token with Google (signature, iss, aud = web
     * client ID, exp) and returns the same success shape as apk-login.
     * 401 = token rejected; 403 = email unverified or not allowlisted.
     */
    private fun postGoogleLogin(idToken: String): LoginResult =
        postAuthRequest(
            GOOGLE_LOGIN_URL,
            JSONObject().apply { put("idToken", idToken) }.toString()
        )

    /**
     * Shared HTTP plumbing for both auth endpoints — both return
     * {phoneToken, deviceName} on 2xx and use 401/403 the same way
     * (mapped to endpoint-specific copy in handleLoginResult).
     */
    private fun postAuthRequest(urlStr: String, body: String): LoginResult {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(urlStr)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            OutputStreamWriter(conn.outputStream).use { it.write(body) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            when (code) {
                in 200..299 -> {
                    val obj = JSONObject(text)
                    val token = obj.optString("phoneToken", "")
                    val deviceName = if (obj.has("deviceName") && !obj.isNull("deviceName")) {
                        obj.optString("deviceName", "")
                    } else null
                    if (token.isNotEmpty()) LoginResult.Success(token, deviceName)
                    else LoginResult.Generic
                }
                401 -> LoginResult.InvalidCredentials
                403 -> LoginResult.Unverified
                else -> {
                    // Bundle C (audit M14) - response body may contain PII
                    // (email echoed back, internal stack frames, DB hints).
                    // Log the full body only in debug builds; release gets
                    // a body-suppressed line.
                    if (BuildConfig.DEBUG) {
                        android.util.Log.w(TAG, "Sign-in HTTP $code: $text")
                    } else {
                        android.util.Log.w(TAG, "Sign-in HTTP $code - body suppressed in release")
                    }
                    LoginResult.Generic
                }
            }
        } catch (e: java.net.SocketTimeoutException) {
            android.util.Log.w(TAG, "Sign-in timeout")
            LoginResult.Network
        } catch (e: java.io.IOException) {
            // Exception class name only; message may include the target URL
            // / cert details which are safe but the exception message can
            // also include user-supplied input on some JDK versions.
            android.util.Log.w(TAG, "Sign-in IOException: ${e.javaClass.simpleName}")
            LoginResult.Network
        } catch (e: Exception) {
            android.util.Log.e(TAG, "Sign-in unexpected: ${e.javaClass.simpleName}")
            LoginResult.Generic
        } finally {
            conn?.disconnect()
        }
    }

    private fun setLoading(loading: Boolean, google: Boolean = false) {
        inFlight = loading
        signInButton.isEnabled = !loading
        signInButton.text = getString(
            if (loading && !google) R.string.signin_action_loading else R.string.signin_action
        )
        googleSignInButton.isEnabled = !loading
        googleSignInButton.text = getString(
            if (loading && google) R.string.signin_google_loading else R.string.signin_google_action
        )
        emailField.isEnabled = !loading
        passwordField.isEnabled = !loading
    }

    private fun showError(msg: String) {
        errorText.text = msg
        errorText.visibility = View.VISIBLE
    }

    private sealed class LoginResult {
        data class Success(val phoneToken: String, val deviceName: String?) : LoginResult()
        object InvalidCredentials : LoginResult()
        object Unverified : LoginResult()
        object Network : LoginResult()
        object Generic : LoginResult()
    }
}

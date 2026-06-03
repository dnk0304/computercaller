package com.dnkdialer.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.FileProvider
import com.google.android.mms.pdu_alt.CharacterSets
import com.google.android.mms.pdu_alt.EncodedStringValue
import com.google.android.mms.pdu_alt.PduBody
import com.google.android.mms.pdu_alt.PduComposer
import com.google.android.mms.pdu_alt.PduHeaders
import com.google.android.mms.pdu_alt.PduPart
import com.google.android.mms.pdu_alt.SendReq
import java.io.File
import java.io.FileOutputStream

data class MmsMessage(
    val id: String,
    val address: String,
    val body: String,
    val date: Long,
    val type: String,  // "inbox" | "sent"
    val mmsType: String = "text"  // "text" | "image" | "audio" | "video" | "other"
)

class MmsHandler(private val context: Context) {

    // Cap removed 2026-05-26 per Dennis pivot ("just make it available for
    // users. If we want to cap it later, we can add a new tier."). Default
    // now: Int.MAX_VALUE (effectively unbounded). Explicit callers (e.g. the
    // 50-row MMS catch-up tick in PhoneService.processNewMms) keep their
    // tight bounds since they pass `limit` explicitly.
    fun getMessages(limit: Int = Int.MAX_VALUE, since: Long = 0): List<MmsMessage> {
        val messages = mutableListOf<MmsMessage>()

        try {
            // Query the MMS table.
            // MMS dates are stored in SECONDS since epoch (unlike SMS which uses ms),
            // so divide the caller-supplied `since` (epoch ms) by 1000 before comparing.
            val selection = if (since > 0) "${Telephony.Mms.DATE} > ?" else null
            val selectionArgs = if (since > 0) arrayOf((since / 1000).toString()) else null

            val cursor = context.contentResolver.query(
                Telephony.Mms.CONTENT_URI,
                arrayOf(
                    Telephony.Mms._ID,
                    Telephony.Mms.DATE,
                    Telephony.Mms.MESSAGE_BOX  // 1=inbox, 2=sent
                ),
                selection,
                selectionArgs,
                "${Telephony.Mms.DATE} DESC"
            )

            cursor?.use {
                var count = 0
                while (it.moveToNext() && count < limit) {
                    val id = it.getString(0) ?: continue
                    val dateSeconds = it.getLong(1)
                    val dateMs = dateSeconds * 1000L
                    val box = it.getInt(2)
                    val msgType = if (box == Telephony.Mms.MESSAGE_BOX_INBOX) "inbox" else "sent"

                    // Get address (sender/recipient)
                    val address = getMmsAddress(id) ?: "Unknown"

                    // Get body and attachment type
                    val (body, mmsType) = getMmsParts(id)

                    messages.add(MmsMessage(
                        id = "mms_$id",
                        address = address,
                        body = body,
                        date = dateMs,
                        type = msgType,
                        mmsType = mmsType
                    ))
                    count++
                }
            }
        } catch (e: SecurityException) {
            android.util.Log.e("MmsHandler", "READ_SMS permission not granted", e)
        } catch (e: Exception) {
            android.util.Log.e("MmsHandler", "Error reading MMS: ${e.message}", e)
        }

        android.util.Log.d("MmsHandler", "getMessages() returned ${messages.size} MMS messages")
        return messages
    }

    private fun getMmsAddress(mmsId: String): String? {
        return try {
            val uri = android.net.Uri.parse("content://mms/$mmsId/addr")
            val cursor = context.contentResolver.query(
                uri,
                arrayOf("address", "type"),
                null, null, null
            )
            cursor?.use {
                // type 137 = FROM, type 151 = TO
                while (it.moveToNext()) {
                    val addr = it.getString(0) ?: continue
                    val addrType = it.getInt(1)
                    if (addrType == 137 || addr != "insert-address-token") {
                        return@use addr
                    }
                }
                null
            }
        } catch (e: Exception) {
            android.util.Log.w("MmsHandler", "Error getting MMS address: ${e.message}")
            null
        }
    }

    private fun getMmsParts(mmsId: String): Pair<String, String> {
        val textParts = mutableListOf<String>()
        var mmsType = "text"

        try {
            val uri = android.net.Uri.parse("content://mms/$mmsId/part")
            val cursor = context.contentResolver.query(
                uri,
                arrayOf("ct", "_data", "text"),
                null, null, null
            )
            cursor?.use {
                while (it.moveToNext()) {
                    val contentType = it.getString(0) ?: continue
                    when {
                        contentType == "text/plain" -> {
                            val text = it.getString(2) ?: ""
                            if (text.isNotBlank()) textParts.add(text)
                        }
                        contentType.startsWith("image/") -> mmsType = "image"
                        contentType.startsWith("audio/") || contentType == "application/ogg" -> mmsType = "audio"
                        contentType.startsWith("video/") -> mmsType = "video"
                        contentType != "application/smil" && contentType != "text/html" -> {
                            if (mmsType == "text") mmsType = "other"
                        }
                    }
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("MmsHandler", "Error getting MMS parts: ${e.message}")
        }

        val body = textParts.joinToString(" ").trim()
        return Pair(body, mmsType)
    }

    /**
     * Extracts a small JPEG thumbnail from the first image part of an MMS,
     * returned as a base64 (NO_WRAP) string. Returns null when no image part
     * exists, decoding fails, or the part is unreadable. Audio/video parts
     * are intentionally skipped here — they're handled separately via
     * GET_MMS_FULL so the web side fetches them on demand instead of
     * preloading every voice note. Max thumbnail dimension is 200 px on the
     * longer side, JPEG quality 75 — small enough to ship inline with the
     * message list without bloating the WebSocket frame.
     *
     * NOTE: caller passes the RAW MMS id (without the "mms_" prefix that
     * SmsHandler adds when converting to SmsMessage shape).
     */
    fun getThumbnail(mmsId: String): String? {
        return try {
            val uri = android.net.Uri.parse("content://mms/$mmsId/part")
            val cursor = context.contentResolver.query(
                uri,
                arrayOf("_id", "ct", "_data"),
                null, null, null
            )
            cursor?.use {
                while (it.moveToNext()) {
                    val partId = it.getString(0) ?: continue
                    val contentType = it.getString(1) ?: continue
                    if (!contentType.startsWith("image/")) continue

                    // Read image bytes from the part URI. openInputStream returns
                    // null when the part has no _data and no inline content — skip.
                    val partUri = android.net.Uri.parse("content://mms/part/$partId")
                    val inputStream = context.contentResolver.openInputStream(partUri) ?: continue
                    val originalBitmap = android.graphics.BitmapFactory.decodeStream(inputStream)
                    inputStream.close()

                    if (originalBitmap == null) continue

                    // Scale to max 200px on the longer side. Never upscale (clamp at 1f).
                    val maxDim = 200
                    val scale = minOf(
                        maxDim.toFloat() / originalBitmap.width,
                        maxDim.toFloat() / originalBitmap.height,
                        1f
                    )
                    val thumbW = (originalBitmap.width * scale).toInt().coerceAtLeast(1)
                    val thumbH = (originalBitmap.height * scale).toInt().coerceAtLeast(1)
                    val thumb = android.graphics.Bitmap.createScaledBitmap(
                        originalBitmap, thumbW, thumbH, true
                    )

                    // Encode as JPEG (75% quality) and base64 it. NO_WRAP avoids
                    // line breaks that would break JSON serialization downstream.
                    val out = java.io.ByteArrayOutputStream()
                    thumb.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, out)
                    originalBitmap.recycle()
                    thumb.recycle()

                    return@use android.util.Base64.encodeToString(
                        out.toByteArray(), android.util.Base64.NO_WRAP
                    )
                }
                null
            }
        } catch (e: Exception) {
            android.util.Log.w("MmsHandler", "Thumbnail extraction failed: ${e.message}")
            null
        }
    }

    /**
     * Reads the first media part (image / audio / video) of an MMS as raw bytes.
     * Returns Pair(mimeType, bytes) or null if no media part is present or the
     * read fails. Used by the GET_MMS_FULL command to ship the original media
     * to the web client in chunked base64 frames — the thumbnail flow is for
     * inline previews only; this is for "play / open full" actions.
     *
     * Caller passes the RAW MMS id (no "mms_" prefix).
     */
    fun getFullMediaData(mmsId: String): Pair<String, ByteArray>? {
        return try {
            val uri = android.net.Uri.parse("content://mms/$mmsId/part")
            val cursor = context.contentResolver.query(
                uri,
                arrayOf("_id", "ct"),
                null, null, null
            )
            cursor?.use {
                while (it.moveToNext()) {
                    val partId = it.getString(0) ?: continue
                    val contentType = it.getString(1) ?: continue
                    if (!contentType.startsWith("image/") &&
                        !contentType.startsWith("audio/") &&
                        !contentType.startsWith("video/")
                    ) continue

                    val partUri = android.net.Uri.parse("content://mms/part/$partId")
                    val bytes = context.contentResolver.openInputStream(partUri)?.readBytes()
                        ?: continue

                    // Transcode AMR to AAC so browsers can play it
                    val (finalMime, finalBytes) = if (contentType == "audio/amr" || contentType == "audio/amr-wb" || contentType == "audio/3gpp") {
                        transcodeAmrToAac(bytes) ?: Pair(contentType, bytes)
                    } else {
                        Pair(contentType, bytes)
                    }

                    return@use Pair(finalMime, finalBytes)
                }
                null
            }
        } catch (e: Exception) {
            android.util.Log.w("MmsHandler", "Full media read failed: ${e.message}")
            null
        }
    }

    /**
     * MMS SEND (2026-06-03) — assemble an M-Send.req PDU containing an image
     * (and optional caption text) and ship it via
     * SmsManager.sendMultimediaMessage(contentUri, ..., sentIntent).
     *
     * Works WITHOUT ComputerCaller being the default SMS app: the
     * SmsManager.sendMultimediaMessage path delegates to the platform
     * com.android.mms.service, which composes and ships the PDU regardless
     * of the caller's default-SMS-app status — only direct SMS_PROVIDER
     * writes (which we never perform) require default-app since KitKat.
     * Same surface ComputerCaller already uses to send plain SMS without
     * being default (see SmsHandler.sendSms).
     *
     * Multi-SIM caveat: if `subId` is null and the device has no default
     * outgoing subscription, sentIntent fires RESULT_NO_DEFAULT_SMS_APP.
     * Pass an explicit `subId` (the simId the web user picked) to route
     * through a specific SIM and skip the default-sub lookup.
     *
     * Caller (PhoneService SEND_MMS handler) supplies the raw image bytes
     * already (browser downscales to ~800KB JPEG before sending). We do
     * NOT downscale again here — the web side controls payload size.
     *
     * @param to           recipient MSISDN (raw or +CC-prefixed; carrier
     *                     normalises)
     * @param body         optional caption text; null/blank → no text part
     * @param mediaBytes   raw image bytes (JPEG/PNG/etc.)
     * @param mimeType     media MIME (e.g. "image/jpeg")
     * @param clientMsgId  correlation id from the web — surfaces in the
     *                     SMS_SEND_STATUS lifecycle frame
     * @param subId        optional subscription id (dual-SIM routing); null
     *                     → SmsManager.getDefault() uses the default sub
     */
    fun sendMms(
        to: String,
        body: String?,
        mediaBytes: ByteArray,
        mimeType: String,
        clientMsgId: String,
        subId: Int? = null
    ) {
        // Set up the cache subdirectory FileProvider exposes (mms-out/).
        // We write the serialized PDU here, hand a content:// URI to the
        // MMS service, and rely on SmsStatusReceiver.MMS_SENT to clean up.
        val cacheDir = File(context.cacheDir, "mms-out").apply { mkdirs() }
        // Filename incorporates clientMsgId so SmsStatusReceiver can match
        // the sent file back to its callback by extra without holding state.
        val pduFile = File(cacheDir, "pdu_${sanitize(clientMsgId)}_${System.currentTimeMillis()}.dat")

        try {
            val pduBytes = composePdu(to, body, mediaBytes, mimeType)
            FileOutputStream(pduFile).use { it.write(pduBytes) }

            val contentUri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.mmsfileprovider",
                pduFile
            )
            // Grant the system MMS service temporary read on the PDU file.
            // The send call ALSO grants via the sendMultimediaMessage API
            // contract, but belt-and-braces against OEM quirks.
            context.grantUriPermission(
                "com.android.mms.service",
                contentUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )

            // sentIntent broadcast — SmsStatusReceiver picks this up and
            // emits SMS_SEND_STATUS back to the web client. Carrying the
            // PDU file path so the receiver can delete the cache file on
            // completion regardless of success/failure.
            val sendIntent = Intent("MMS_SENT").apply {
                putExtra("clientMsgId", clientMsgId)
                putExtra("to", to)
                putExtra("pduFilePath", pduFile.absolutePath)
                `package` = context.packageName
            }
            val sentPI = PendingIntent.getBroadcast(
                context,
                ("mms-" + clientMsgId).hashCode(),
                sendIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            // Pick the SmsManager: per-subscription when the web picked a
            // SIM, otherwise the system default. createForSubscriptionId
            // is API 22+ which is well under our minSdk 26.
            val manager: SmsManager = if (subId != null && subId >= 0) {
                try {
                    context.getSystemService(SmsManager::class.java)
                        .createForSubscriptionId(subId)
                } catch (e: Exception) {
                    android.util.Log.w(
                        "MmsHandler",
                        "createForSubscriptionId($subId) failed, falling back to default: ${e.message}"
                    )
                    context.getSystemService(SmsManager::class.java)
                }
            } else {
                context.getSystemService(SmsManager::class.java)
            }

            android.util.Log.d(
                "MmsHandler",
                "sendMms: to=$to clientMsgId=$clientMsgId pdu=${pduBytes.size}B subId=${subId ?: "default"}"
            )

            manager.sendMultimediaMessage(
                context,
                contentUri,
                null,        // locationUrl = null → MmsService reads the carrier MMSC from APN config
                null,        // configOverrides — leave null, use platform defaults
                sentPI
            )
        } catch (e: SecurityException) {
            android.util.Log.e("MmsHandler", "sendMms: SEND_SMS permission denied", e)
            // Surface as a synthetic failure so the web bubble doesn't
            // stay pending forever. SmsStatusReceiver normally emits this
            // via the sentIntent, but if SmsManager rejected the call
            // outright we have to fire it ourselves.
            broadcastFailure(clientMsgId, to, "Permission denied (SEND_SMS)")
            pduFile.delete()
        } catch (e: Exception) {
            android.util.Log.e("MmsHandler", "sendMms: PDU composition / dispatch failed", e)
            broadcastFailure(clientMsgId, to, "PDU build failed: ${e.message ?: e.javaClass.simpleName}")
            pduFile.delete()
        }
    }

    /**
     * Compose the M-Send.req PDU bytes for a single-recipient image MMS.
     *
     * Layout: SMIL slide with one image region (and a text region when
     * `body` is non-blank) + the image PduPart + an optional text PduPart.
     * The SMIL is what every other MMS app uses — it's how the recipient's
     * client knows to render the image (and caption) together as one
     * slide. Most carriers accept image-only PDUs too, but including a
     * SMIL is the canonical/maximum-compatibility path.
     */
    private fun composePdu(
        to: String,
        body: String?,
        mediaBytes: ByteArray,
        mimeType: String
    ): ByteArray {
        val pduBody = PduBody()

        // SMIL part (presentation layer). Content-ID="<smil>", Content-Location="smil.xml",
        // ContentType="application/smil". MUST be the first part by convention so
        // recipient clients find it before the media parts.
        val smilXml = if (!body.isNullOrBlank()) {
            "<smil><head><layout>" +
                "<root-layout/>" +
                "<region id=\"Image\" top=\"0\" left=\"0\" height=\"80%\" width=\"100%\"/>" +
                "<region id=\"Text\" top=\"80%\" left=\"0\" height=\"20%\" width=\"100%\"/>" +
                "</layout></head><body><par dur=\"5000ms\">" +
                "<img src=\"image\" region=\"Image\"/>" +
                "<text src=\"text\" region=\"Text\"/>" +
                "</par></body></smil>"
        } else {
            "<smil><head><layout>" +
                "<root-layout/>" +
                "<region id=\"Image\" top=\"0\" left=\"0\" height=\"100%\" width=\"100%\"/>" +
                "</layout></head><body><par dur=\"5000ms\">" +
                "<img src=\"image\" region=\"Image\"/>" +
                "</par></body></smil>"
        }
        // Explicit setters (not Kotlin property syntax) for PduPart fields —
        // same rationale as SendReq below: avoid name-collision ambiguity
        // with the outer `body` parameter / Kotlin's property-write
        // resolution against the Java setter set.
        val smilPart = PduPart()
        smilPart.setContentType("application/smil".toByteArray())
        smilPart.setContentLocation("smil.xml".toByteArray())
        smilPart.setContentId("<smil>".toByteArray())
        smilPart.setData(smilXml.toByteArray())
        pduBody.addPart(smilPart)

        // Image part. ContentLocation matches the SMIL `src` so the receiver
        // can wire the part to the slide. contentId is required by some
        // carriers; angle-brackets per RFC 2392.
        val imagePart = PduPart()
        imagePart.setContentType(mimeType.toByteArray())
        imagePart.setContentLocation("image".toByteArray())
        imagePart.setContentId("<image>".toByteArray())
        imagePart.setData(mediaBytes)
        pduBody.addPart(imagePart)

        // Optional text part.
        if (!body.isNullOrBlank()) {
            val textPart = PduPart()
            textPart.setContentType("text/plain".toByteArray())
            textPart.setCharset(CharacterSets.UTF_8)
            textPart.setContentLocation("text".toByteArray())
            textPart.setContentId("<text>".toByteArray())
            textPart.setData(body.toByteArray(Charsets.UTF_8))
            pduBody.addPart(textPart)
        }

        // SendReq envelope. Use explicit setX(...) calls (not Kotlin
        // property syntax) so the outer `body: String?` function parameter
        // doesn't shadow setBody(PduBody) — Kotlin's property-assignment
        // resolution gets ambiguous when a Java setter and a captured
        // local share a name. Mirrors qksms / klinker reference usage.
        val sendReq = SendReq()
        // Recipient. EncodedStringValue handles WSP encoding.
        sendReq.addTo(EncodedStringValue(to))
        // No subject — most carriers/clients ignore it for image MMS.
        // Date is auto-stamped by SendReq.
        sendReq.setMessageClass("personal".toByteArray())
        sendReq.setExpiry((7 * 24 * 60 * 60).toLong())          // 7 days; carrier caps anyway
        sendReq.setPriority(PduHeaders.PRIORITY_NORMAL)         // 0x81
        // Delivery + read reports off — same default as the platform
        // Messages app for everyday picture messages.
        sendReq.setDeliveryReport(PduHeaders.VALUE_NO)
        sendReq.setReadReport(PduHeaders.VALUE_NO)
        // Bind the body.
        sendReq.setBody(pduBody)

        // Serialize.
        val composer = PduComposer(context, sendReq)
        return composer.make()
            ?: throw IllegalStateException("PduComposer.make() returned null — composition failed")
    }

    /**
     * Sanitize a clientMsgId for use in a filename (strip everything that
     * isn't alphanumeric / dash / underscore). The id format we ship is
     * `${Date.now()}-${random36}`, so this is defensive only.
     */
    private fun sanitize(id: String): String =
        id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(40)

    /**
     * Fire a synthetic MMS_SENT broadcast as failure when we couldn't even
     * reach the SmsManager dispatch (permission denial, PDU build error).
     * SmsStatusReceiver picks this up and emits SMS_SEND_STATUS:failed back
     * to the web bubble so it doesn't stay pending forever.
     */
    private fun broadcastFailure(clientMsgId: String, to: String, reason: String) {
        val intent = Intent("MMS_SENT").apply {
            putExtra("clientMsgId", clientMsgId)
            putExtra("to", to)
            putExtra("synthetic_failure_reason", reason)
            `package` = context.packageName
        }
        // sendBroadcast goes through the ordered intent path the same way
        // PendingIntent.send would, so the receiver's resultCode stays at
        // its default (Activity.RESULT_CANCELED) → treated as failure.
        context.sendBroadcast(intent)
    }

    private fun transcodeAmrToAac(amrBytes: ByteArray): Pair<String, ByteArray>? {
        val tempInput = java.io.File(context.cacheDir, "amr_input_${System.currentTimeMillis()}.amr")
        val tempOutput = java.io.File(context.cacheDir, "aac_output_${System.currentTimeMillis()}.m4a")

        return try {
            tempInput.writeBytes(amrBytes)

            val extractor = android.media.MediaExtractor()
            extractor.setDataSource(tempInput.absolutePath)

            if (extractor.trackCount == 0) {
                extractor.release()
                return null
            }

            extractor.selectTrack(0)
            val inputFormat = extractor.getTrackFormat(0)

            // Read actual sample rate / channel count from the source. AMR-NB is 8 kHz,
            // AMR-WB is 16 kHz — hardcoding 44.1 kHz here caused playback at ~5.5x speed.
            val inputSampleRate = if (inputFormat.containsKey(android.media.MediaFormat.KEY_SAMPLE_RATE)) {
                inputFormat.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE)
            } else {
                8000 // AMR-NB default
            }
            val inputChannelCount = if (inputFormat.containsKey(android.media.MediaFormat.KEY_CHANNEL_COUNT)) {
                inputFormat.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT)
            } else {
                1 // AMR is always mono
            }

            // Set up AAC encoder
            val muxer = android.media.MediaMuxer(tempOutput.absolutePath, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

            val encoderFormat = android.media.MediaFormat.createAudioFormat(
                android.media.MediaFormat.MIMETYPE_AUDIO_AAC,
                inputSampleRate,
                inputChannelCount
            )
            encoderFormat.setInteger(android.media.MediaFormat.KEY_BIT_RATE, 64000)
            encoderFormat.setInteger(android.media.MediaFormat.KEY_AAC_PROFILE, android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            encoderFormat.setInteger(android.media.MediaFormat.KEY_MAX_INPUT_SIZE, 16384)

            val decoder = android.media.MediaCodec.createDecoderByType(inputFormat.getString(android.media.MediaFormat.KEY_MIME) ?: "audio/3gpp")
            val encoder = android.media.MediaCodec.createEncoderByType(android.media.MediaFormat.MIMETYPE_AUDIO_AAC)

            decoder.configure(inputFormat, null, null, 0)
            encoder.configure(encoderFormat, null, null, android.media.MediaCodec.CONFIGURE_FLAG_ENCODE)

            decoder.start()
            encoder.start()

            val bufferInfo = android.media.MediaCodec.BufferInfo()
            var muxerTrackIndex = -1
            var encodingDone = false
            var decodingDone = false

            val pcmBuffer = java.nio.ByteBuffer.allocateDirect(65536)

            while (!encodingDone) {
                // Feed input to decoder
                if (!decodingDone) {
                    val inputBufIdx = decoder.dequeueInputBuffer(10000)
                    if (inputBufIdx >= 0) {
                        val inputBuf = decoder.getInputBuffer(inputBufIdx)!!
                        val sampleSize = extractor.readSampleData(inputBuf, 0)
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(inputBufIdx, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            decodingDone = true
                        } else {
                            decoder.queueInputBuffer(inputBufIdx, 0, sampleSize, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }

                // Get decoded PCM from decoder, feed to encoder
                val decoderOutputIdx = decoder.dequeueOutputBuffer(bufferInfo, 10000)
                if (decoderOutputIdx >= 0) {
                    val decodedBuf = decoder.getOutputBuffer(decoderOutputIdx)!!
                    val isEos = (bufferInfo.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0

                    val encoderInputIdx = encoder.dequeueInputBuffer(10000)
                    if (encoderInputIdx >= 0) {
                        val encoderInput = encoder.getInputBuffer(encoderInputIdx)!!
                        encoderInput.clear()
                        encoderInput.put(decodedBuf)
                        encoder.queueInputBuffer(encoderInputIdx, 0, decodedBuf.limit(), bufferInfo.presentationTimeUs,
                            if (isEos) android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                    }
                    decoder.releaseOutputBuffer(decoderOutputIdx, false)
                }

                // Get encoded AAC from encoder, write to muxer
                val encoderOutputIdx = encoder.dequeueOutputBuffer(bufferInfo, 10000)
                when {
                    encoderOutputIdx == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        muxerTrackIndex = muxer.addTrack(encoder.outputFormat)
                        muxer.start()
                    }
                    encoderOutputIdx >= 0 -> {
                        val encodedBuf = encoder.getOutputBuffer(encoderOutputIdx)!!
                        if (muxerTrackIndex >= 0 && bufferInfo.size > 0 && (bufferInfo.flags and android.media.MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            muxer.writeSampleData(muxerTrackIndex, encodedBuf, bufferInfo)
                        }
                        encoder.releaseOutputBuffer(encoderOutputIdx, false)
                        if ((bufferInfo.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            encodingDone = true
                        }
                    }
                }
            }

            decoder.stop(); decoder.release()
            encoder.stop(); encoder.release()
            extractor.release()
            muxer.stop(); muxer.release()

            val aacBytes = tempOutput.readBytes()
            android.util.Log.d("MmsHandler", "AMR→AAC transcoding done: ${amrBytes.size}B → ${aacBytes.size}B")
            Pair("audio/aac", aacBytes)
        } catch (e: Exception) {
            android.util.Log.w("MmsHandler", "AMR transcoding failed: ${e.message}")
            null
        } finally {
            tempInput.delete()
            tempOutput.delete()
        }
    }
}

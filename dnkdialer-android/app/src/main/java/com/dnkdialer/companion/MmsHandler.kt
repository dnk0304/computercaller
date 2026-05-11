package com.dnkdialer.companion

import android.content.Context
import android.provider.Telephony

data class MmsMessage(
    val id: String,
    val address: String,
    val body: String,
    val date: Long,
    val type: String,  // "inbox" | "sent"
    val mmsType: String = "text"  // "text" | "image" | "audio" | "video" | "other"
)

class MmsHandler(private val context: Context) {

    fun getMessages(limit: Int = 2500, since: Long = 0): List<MmsMessage> {
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

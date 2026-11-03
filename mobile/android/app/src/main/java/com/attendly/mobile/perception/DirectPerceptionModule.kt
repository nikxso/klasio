package com.attendly.mobile.perception

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.mrousavy.camera.react.CameraView
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class DirectPerceptionModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val TAG = "DirectPerception"
        const val MODULE_NAME = "DirectPerception"
    }

    private var ortEnv: OrtEnvironment? = null
    private var ortSession: OrtSession? = null
    private var recognizerSession: OrtSession? = null
    private var currentModelName: String = "YuNet"
    private var currentRecognizerName: String = "EdgeFace-XS"
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    override fun getName(): String = MODULE_NAME

    private fun getModelFile(modelFileName: String): File {
        // Priority 1: Check /data/local/tmp/atten_lab/models/
        val labPath = File("/data/local/tmp/atten_lab/models/$modelFileName")
        if (labPath.exists() && labPath.canRead()) {
            Log.i(TAG, "Using model from lab storage: ${labPath.absolutePath}")
            return labPath
        }

        // Priority 2: Check app filesDir cache
        val localFile = File(reactContext.filesDir, modelFileName)
        if (localFile.exists() && localFile.length() > 0) {
            return localFile
        }

        // Priority 3: Extract from APK assets
        try {
            reactContext.assets.open("models/$modelFileName").use { input ->
                FileOutputStream(localFile).use { output ->
                    input.copyTo(output)
                }
            }
            Log.i(TAG, "Extracted model from assets: ${localFile.absolutePath} (${localFile.length()} bytes)")
            return localFile
        } catch (e: Exception) {
            Log.w(TAG, "Could not extract asset models/$modelFileName: ${e.message}")
        }

        return localFile
    }

    private fun ensureOrtInitialized(modelName: String = "YuNet") {
        if (ortEnv == null) {
            ortEnv = OrtEnvironment.getEnvironment()
        }

        if (ortSession == null || currentModelName != modelName) {
            val fileName = when (modelName.lowercase()) {
                "scrfd", "scrfd-500m" -> "det_500m.onnx"
                else -> "yunet_2023mar.onnx"
            }
            val modelFile = getModelFile(fileName)
            if (!modelFile.exists()) {
                throw IllegalStateException("Model file not found: ${modelFile.absolutePath}")
            }

            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(4)
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            }
            ortSession?.close()
            ortSession = ortEnv!!.createSession(modelFile.absolutePath, opts)
            currentModelName = modelName
            Log.i(TAG, "Loaded ONNX model '$modelName' from ${modelFile.absolutePath}")
        }
    }

    private fun ensureRecognizerInitialized(modelName: String = "EdgeFace-XS") {
        if (ortEnv == null) {
            ortEnv = OrtEnvironment.getEnvironment()
        }

        if (recognizerSession == null || currentRecognizerName != modelName) {
            val fileName = when (modelName.lowercase()) {
                "mobilefacenet", "w600k_mbf" -> "w600k_mbf.onnx"
                else -> "edgeface_xs.onnx"
            }
            val modelFile = getModelFile(fileName)
            if (!modelFile.exists()) {
                throw IllegalStateException("Recognizer model file not found: ${modelFile.absolutePath}")
            }

            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(4)
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            }
            recognizerSession?.close()
            recognizerSession = ortEnv!!.createSession(modelFile.absolutePath, opts)
            currentRecognizerName = modelName
            Log.i(TAG, "Loaded ONNX recognizer '$modelName' from ${modelFile.absolutePath}")
        }
    }

    @ReactMethod
    fun initDetector(modelName: String, promise: Promise) {
        scope.launch {
            try {
                ensureOrtInitialized(modelName)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("INIT_ERROR", "Failed to initialize detector: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun initRecognizer(modelName: String, promise: Promise) {
        scope.launch {
            try {
                ensureRecognizerInitialized(modelName)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("INIT_RECOGNIZER_ERROR", "Failed to initialize recognizer: ${e.message}", e)
            }
        }
    }

    private suspend fun grabBitmapFromCamera(viewTag: Int): Pair<Bitmap, Long> {
        val grabStart = System.nanoTime()
        return withContext(Dispatchers.Main) {
            val uiManager = UIManagerHelper.getUIManager(reactContext, UIManagerType.FABRIC)
                ?: UIManagerHelper.getUIManager(reactContext, UIManagerType.DEFAULT)
                ?: throw IllegalStateException("UIManager not found")

            val view = uiManager.resolveView(viewTag)
                ?: throw IllegalStateException("View not found for tag: $viewTag")

            val cameraView = view as? CameraView
                ?: throw IllegalStateException("View is not a CameraView (was ${view::class.java.simpleName})")

            val previewViewField = CameraView::class.java.getDeclaredField("previewView").apply {
                isAccessible = true
            }
            val previewViewObj = previewViewField.get(cameraView)
                ?: throw IllegalStateException("PreviewView is null in CameraView")

            val getBitmapMethod = previewViewObj::class.java.getMethod("getBitmap")
            val bitmap = getBitmapMethod.invoke(previewViewObj) as? Bitmap
                ?: throw IllegalStateException("previewView.getBitmap() returned null")

            val grabMs = (System.nanoTime() - grabStart) / 1_000_000
            Pair(bitmap, grabMs)
        }
    }

    private fun runNms(
        boxes: List<FloatArray>,
        scores: List<Float>,
        iouThresh: Float = 0.4f
    ): List<Int> {
        if (boxes.isEmpty()) return emptyList()

        val indices = scores.indices.sortedByDescending { scores[it] }.toMutableList()
        val keep = mutableListOf<Int>()

        while (indices.isNotEmpty()) {
            val current = indices.removeAt(0)
            keep.add(current)

            val curBox = boxes[current]
            val curArea = curBox[2] * curBox[3]

            indices.removeAll { idx ->
                val otherBox = boxes[idx]
                val xx1 = max(curBox[0], otherBox[0])
                val yy1 = max(curBox[1], otherBox[1])
                val xx2 = min(curBox[0] + curBox[2], otherBox[0] + otherBox[2])
                val yy2 = min(curBox[1] + curBox[3], otherBox[1] + otherBox[3])

                val w = max(0f, xx2 - xx1)
                val h = max(0f, yy2 - yy1)
                val inter = w * h
                val otherArea = otherBox[2] * otherBox[3]
                val union = curArea + otherArea - inter

                val iou = if (union > 0f) inter / union else 0f
                iou > iouThresh
            }
        }
        return keep
    }

    /**
     * Aligns a detected face using 5-point similarity transform to canonical ArcFace coordinates,
     * normalizes to NCHW RGB [-1, 1], and runs genuine ONNX neural inference returning unit L2 vector.
     */
    private fun alignAndEmbedFace(
        sourceBitmap: Bitmap,
        box: FloatArray,
        kps: FloatArray?
    ): Pair<FloatArray, String> {
        val targetDim = 112
        val alignedBitmap = Bitmap.createBitmap(targetDim, targetDim, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(alignedBitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

        var alignedWithLandmarks = false
        if (kps != null && kps.size >= 10) {
            val dst = floatArrayOf(
                38.2946f, 51.6963f, // right eye (image left)
                73.5318f, 51.5014f, // left eye (image right)
                56.0252f, 71.7366f, // nose tip
                41.5493f, 92.3655f, // right mouth (image left)
                70.7299f, 92.2041f  // left mouth (image right)
            )

            val mx = (kps[0] + kps[2] + kps[4] + kps[6] + kps[8]) / 5f
            val my = (kps[1] + kps[3] + kps[5] + kps[7] + kps[9]) / 5f
            val txm = (dst[0] + dst[2] + dst[4] + dst[6] + dst[8]) / 5f
            val tym = (dst[1] + dst[3] + dst[5] + dst[7] + dst[9]) / 5f

            var den = 0f
            var numA = 0f
            var numB = 0f
            for (i in 0 until 5) {
                val sx = kps[i * 2] - mx
                val sy = kps[i * 2 + 1] - my
                val dx = dst[i * 2] - txm
                val dy = dst[i * 2 + 1] - tym
                den += sx * sx + sy * sy
                numA += sx * dx + sy * dy
                numB += sx * dy - sy * dx
            }

            if (den > 1e-6f) {
                val a = numA / den
                val b = numB / den
                val tx = txm - (a * mx - b * my)
                val ty = tym - (b * mx + a * my)

                val matrix = Matrix()
                matrix.setValues(floatArrayOf(
                    a, -b, tx,
                    b,  a, ty,
                    0f, 0f, 1f
                ))
                canvas.drawBitmap(sourceBitmap, matrix, paint)
                alignedWithLandmarks = true
            }
        }

        if (!alignedWithLandmarks) {
            val padW = box[2] * 0.15f
            val padH = box[3] * 0.15f
            val cropX = max(0f, box[0] - padW).toInt()
            val cropY = max(0f, box[1] - padH).toInt()
            val cropW = min(sourceBitmap.width - cropX, (box[2] + 2 * padW).toInt())
            val cropH = min(sourceBitmap.height - cropY, (box[3] + 2 * padH).toInt())
            if (cropW > 0 && cropH > 0) {
                val cropped = Bitmap.createBitmap(sourceBitmap, cropX, cropY, cropW, cropH)
                val scaledCrop = Bitmap.createScaledBitmap(cropped, targetDim, targetDim, true)
                canvas.drawBitmap(scaledCrop, 0f, 0f, paint)
                if (cropped != scaledCrop) cropped.recycle()
                scaledCrop.recycle()
            }
        }

        val pixels = IntArray(targetDim * targetDim)
        alignedBitmap.getPixels(pixels, 0, targetDim, 0, 0, targetDim, targetDim)
        val floatBuffer = FloatBuffer.allocate(1 * 3 * targetDim * targetDim)
        val numPixels = targetDim * targetDim

        // Preprocessing: RGB NCHW layout, (val - 127.5f) / 127.5f (Authoritative upstream ArcFace/EdgeFace contract)
        for (i in 0 until numPixels) {
            val r = (pixels[i] shr 16) and 0xFF
            floatBuffer.put((r - 127.5f) / 127.5f)
        }
        for (i in 0 until numPixels) {
            val g = (pixels[i] shr 8) and 0xFF
            floatBuffer.put((g - 127.5f) / 127.5f)
        }
        for (i in 0 until numPixels) {
            val b = pixels[i] and 0xFF
            floatBuffer.put((b - 127.5f) / 127.5f)
        }
        floatBuffer.rewind()

        val tensor = OnnxTensor.createTensor(
            ortEnv,
            floatBuffer,
            longArrayOf(1, 3, targetDim.toLong(), targetDim.toLong())
        )

        val inputName = recognizerSession!!.inputNames.iterator().next()
        val outputs = recognizerSession!!.run(mapOf(inputName to tensor))
        val outputTensor = outputs.get(0) as OnnxTensor
        val embBuf = outputTensor.floatBuffer
        val dim = embBuf.capacity()
        val rawVector = FloatArray(dim)
        embBuf.get(rawVector, 0, dim)

        tensor.close()
        outputs.close()
        alignedBitmap.recycle()

        // L2 Unit Normalization
        var sumSq = 0.0
        for (v in rawVector) {
            sumSq += (v * v).toDouble()
        }
        val norm = sqrt(sumSq).toFloat()
        val normalized = FloatArray(dim)
        if (norm > 1e-12f) {
            for (i in 0 until dim) {
                normalized[i] = rawVector[i] / norm
            }
        }

        // Little-Endian RFC 4648 Base64
        val byteBuf = ByteBuffer.allocate(dim * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (v in normalized) {
            byteBuf.putFloat(v)
        }
        val base64 = Base64.encodeToString(byteBuf.array(), Base64.NO_WRAP)

        return Pair(normalized, base64)
    }

    @ReactMethod
    fun computeEmbedding(viewTag: Int, boxMap: ReadableMap, landmarksMap: ReadableMap?, promise: Promise) {
        val targetDim = 640
        scope.launch {
            try {
                ensureRecognizerInitialized("EdgeFace-XS")
                val (rawBitmap, _) = grabBitmapFromCamera(viewTag)
                val origW = rawBitmap.width
                val origH = rawBitmap.height
                val scaled = if (origW == targetDim && origH == targetDim) {
                    rawBitmap
                } else {
                    Bitmap.createScaledBitmap(rawBitmap, targetDim, targetDim, true)
                }

                val normX = boxMap.getDouble("x").toFloat()
                val normY = boxMap.getDouble("y").toFloat()
                val normW = boxMap.getDouble("width").toFloat()
                val normH = boxMap.getDouble("height").toFloat()
                val box = floatArrayOf(normX * targetDim, normY * targetDim, normW * targetDim, normH * targetDim)

                val kps = if (landmarksMap != null &&
                    landmarksMap.hasKey("rightEye") &&
                    landmarksMap.hasKey("leftEye") &&
                    landmarksMap.hasKey("noseTip") &&
                    landmarksMap.hasKey("rightMouth") &&
                    landmarksMap.hasKey("leftMouth")
                ) {
                    val rEye = landmarksMap.getMap("rightEye")!!
                    val lEye = landmarksMap.getMap("leftEye")!!
                    val nose = landmarksMap.getMap("noseTip")!!
                    val rMouth = landmarksMap.getMap("rightMouth")!!
                    val lMouth = landmarksMap.getMap("leftMouth")!!
                    floatArrayOf(
                        rEye.getDouble("x").toFloat() * targetDim, rEye.getDouble("y").toFloat() * targetDim,
                        lEye.getDouble("x").toFloat() * targetDim, lEye.getDouble("y").toFloat() * targetDim,
                        nose.getDouble("x").toFloat() * targetDim, nose.getDouble("y").toFloat() * targetDim,
                        rMouth.getDouble("x").toFloat() * targetDim, rMouth.getDouble("y").toFloat() * targetDim,
                        lMouth.getDouble("x").toFloat() * targetDim, lMouth.getDouble("y").toFloat() * targetDim
                    )
                } else null

                val (emb, b64) = alignAndEmbedFace(scaled, box, kps)
                if (scaled != rawBitmap) scaled.recycle()

                val embArr = Arguments.createArray()
                for (v in emb) embArr.pushDouble(v.toDouble())

                val res = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putArray("embedding", embArr)
                    putString("embeddingBase64", b64)
                    putInt("dimension", emb.size)
                    putString("model", currentRecognizerName)
                }
                promise.resolve(res)
            } catch (e: Exception) {
                Log.e(TAG, "computeEmbedding failed", e)
                promise.reject("EMBEDDING_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun detectFacesInMemory(viewTag: Int, options: ReadableMap?, promise: Promise) {
        val totalStart = System.nanoTime()
        val captureTimestampMs = System.currentTimeMillis()
        val confThresh = (options?.getDouble("confidenceThreshold") ?: 0.35).toFloat()
        val computeEmbeddings = if (options?.hasKey("computeEmbeddings") == true) options.getBoolean("computeEmbeddings") else true
        val targetDim = 640

        scope.launch {
            try {
                ensureOrtInitialized("YuNet")
                if (computeEmbeddings) {
                    try {
                        ensureRecognizerInitialized("EdgeFace-XS")
                    } catch (recErr: Exception) {
                        Log.w(TAG, "Recognizer preload warning: ${recErr.message}")
                    }
                }

                // Stage 1: IN-MEMORY FRAME ACQUISITION (ZERO DISK, ZERO JPEG)
                val (rawBitmap, grabMs) = grabBitmapFromCamera(viewTag)

                // Stage 2: IN-MEMORY PREPROCESSING
                val preStart = System.nanoTime()
                val origW = rawBitmap.width
                val origH = rawBitmap.height

                val scaled = if (origW == targetDim && origH == targetDim) {
                    rawBitmap
                } else {
                    Bitmap.createScaledBitmap(rawBitmap, targetDim, targetDim, true)
                }

                val pixels = IntArray(targetDim * targetDim)
                scaled.getPixels(pixels, 0, targetDim, 0, 0, targetDim, targetDim)

                val floatBuffer = FloatBuffer.allocate(1 * 3 * targetDim * targetDim)
                val numPixels = targetDim * targetDim

                // CHW layout with BGR channels (standard YuNet format, values 0.0 to 255.0)
                for (c in 0 until 3) {
                    for (i in 0 until numPixels) {
                        val p = pixels[i]
                        val v = when (c) {
                            0 -> (p and 0xFF).toFloat()         // Blue
                            1 -> ((p shr 8) and 0xFF).toFloat()  // Green
                            2 -> ((p shr 16) and 0xFF).toFloat() // Red
                            else -> 0f
                        }
                        floatBuffer.put(v)
                    }
                }
                floatBuffer.rewind()

                val tensor = OnnxTensor.createTensor(
                    ortEnv,
                    floatBuffer,
                    longArrayOf(1, 3, targetDim.toLong(), targetDim.toLong())
                )
                val preprocMs = (System.nanoTime() - preStart) / 1_000_000

                // Stage 3: ON-DEVICE NEURAL INFERENCE (LOCAL ONNX RUNTIME)
                val inferStart = System.nanoTime()
                val outputs = ortSession!!.run(mapOf("input" to tensor))
                val inferMs = (System.nanoTime() - inferStart) / 1_000_000

                // Stage 4: IN-MEMORY POSTPROCESSING & STRIDE DECODING
                val postStart = System.nanoTime()
                val strides = intArrayOf(8, 16, 32)
                val rawBoxes = mutableListOf<FloatArray>()
                val rawScores = mutableListOf<Float>()
                val rawKps = mutableListOf<FloatArray>()

                for (stride in strides) {
                    val clsTensor = outputs.get("cls_$stride").get() as OnnxTensor
                    val objTensor = outputs.get("obj_$stride").get() as OnnxTensor
                    val bboxTensor = outputs.get("bbox_$stride").get() as OnnxTensor
                    val kpsTensor = outputs.get("kps_$stride").get() as OnnxTensor

                    val clsBuf = clsTensor.floatBuffer
                    val objBuf = objTensor.floatBuffer
                    val bboxBuf = bboxTensor.floatBuffer
                    val kpsBuf = kpsTensor.floatBuffer

                    val gridW = targetDim / stride
                    val numAnchors = clsBuf.capacity()

                    for (i in 0 until numAnchors) {
                        val clsVal = clsBuf.get(i)
                        val objVal = objBuf.get(i)
                        val score = sqrt(max(0.0, (clsVal * objVal).toDouble())).toFloat()

                        if (score >= confThresh) {
                            val c = (i % gridW).toFloat()
                            val r = (i / gridW).toFloat()

                            val dx = bboxBuf.get(i * 4 + 0)
                            val dy = bboxBuf.get(i * 4 + 1)
                            val dw = bboxBuf.get(i * 4 + 2)
                            val dh = bboxBuf.get(i * 4 + 3)

                            val cx = (c + dx) * stride
                            val cy = (r + dy) * stride
                            val w = exp(dw.toDouble()).toFloat() * stride
                            val h = exp(dh.toDouble()).toFloat() * stride
                            val x = cx - w / 2f
                            val y = cy - h / 2f

                            rawBoxes.add(floatArrayOf(x, y, w, h))
                            rawScores.add(score)

                            val kps = FloatArray(10)
                            for (k in 0 until 5) {
                                kps[k * 2 + 0] = (c + kpsBuf.get(i * 10 + 2 * k + 0)) * stride
                                kps[k * 2 + 1] = (r + kpsBuf.get(i * 10 + 2 * k + 1)) * stride
                            }
                            rawKps.add(kps)
                        }
                    }
                }

                val keep = runNms(rawBoxes, rawScores, 0.4f)
                val facesArray = Arguments.createArray()

                for ((fIdx, kIdx) in keep.withIndex()) {
                    val box = rawBoxes[kIdx]
                    val score = rawScores[kIdx]
                    val kps = rawKps[kIdx]

                    val normX = max(0f, min(1f, box[0] / targetDim))
                    val normY = max(0f, min(1f, box[1] / targetDim))
                    val normW = max(0f, min(1f - normX, box[2] / targetDim))
                    val normH = max(0f, min(1f - normY, box[3] / targetDim))

                    val faceMap = Arguments.createMap().apply {
                        putString("id", "inmem_face_${fIdx + 1}")
                        putDouble("confidence", Math.round(score * 1000.0) / 1000.0)

                        val bMap = Arguments.createMap().apply {
                            putDouble("x", normX.toDouble())
                            putDouble("y", normY.toDouble())
                            putDouble("width", normW.toDouble())
                            putDouble("height", normH.toDouble())
                        }
                        putMap("box", bMap)

                        val lmMap = Arguments.createMap().apply {
                            putMap("rightEye", Arguments.createMap().apply {
                                putDouble("x", (kps[0] / targetDim).toDouble())
                                putDouble("y", (kps[1] / targetDim).toDouble())
                            })
                            putMap("leftEye", Arguments.createMap().apply {
                                putDouble("x", (kps[2] / targetDim).toDouble())
                                putDouble("y", (kps[3] / targetDim).toDouble())
                            })
                            putMap("noseTip", Arguments.createMap().apply {
                                putDouble("x", (kps[4] / targetDim).toDouble())
                                putDouble("y", (kps[5] / targetDim).toDouble())
                            })
                            putMap("rightMouth", Arguments.createMap().apply {
                                putDouble("x", (kps[6] / targetDim).toDouble())
                                putDouble("y", (kps[7] / targetDim).toDouble())
                            })
                            putMap("leftMouth", Arguments.createMap().apply {
                                putDouble("x", (kps[8] / targetDim).toDouble())
                                putDouble("y", (kps[9] / targetDim).toDouble())
                            })
                        }
                        putMap("landmarks", lmMap)

                        // Stage 4B: GENUINE ONNX NEURAL EMBEDDING (512-D L2 Normalized)
                        if (computeEmbeddings && recognizerSession != null) {
                            try {
                                val (emb, b64) = alignAndEmbedFace(scaled, box, kps)
                                val embArr = Arguments.createArray()
                                for (v in emb) {
                                    embArr.pushDouble(v.toDouble())
                                }
                                putArray("embedding", embArr)
                                putString("embeddingBase64", b64)
                            } catch (embErr: Exception) {
                                Log.w(TAG, "Embedding extraction failed for face $fIdx: ${embErr.message}")
                            }
                        }
                    }
                    facesArray.pushMap(faceMap)
                }

                val postprocMs = (System.nanoTime() - postStart) / 1_000_000
                val totalE2EMs = (System.nanoTime() - totalStart) / 1_000_000

                // Stage 5: BUILD RESPONSE MAP
                val timingsMap = Arguments.createMap().apply {
                    putDouble("frameAcquisitionMs", grabMs.toDouble())
                    putDouble("preprocessMs", preprocMs.toDouble())
                    putDouble("onnxInferenceMs", inferMs.toDouble())
                    putDouble("postprocessMs", postprocMs.toDouble())
                    putDouble("totalEndToEndMs", totalE2EMs.toDouble())
                }

                val result = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putString("detector", "YuNet (Direct In-Memory)")
                    putString("recognizer", if (computeEmbeddings && recognizerSession != null) currentRecognizerName else "None")
                    putString("modelVersion", "2023mar-ort-inmem")
                    putDouble("captureTimestamp", captureTimestampMs.toDouble())
                    putInt("facesCount", keep.size)
                    putArray("faces", facesArray)
                    putMap("timings", timingsMap)
                    putDouble("totalLatencyMs", totalE2EMs.toDouble())
                    putDouble("inferenceLatencyMs", inferMs.toDouble())
                }

                tensor.close()
                outputs.close()
                if (scaled != rawBitmap) {
                    scaled.recycle()
                }

                promise.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Direct in-memory detection error", e)
                promise.reject("DETECTION_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun capturePhotoFromCamera(viewTag: Int, promise: Promise) {
        scope.launch {
            try {
                val (rawBitmap, _) = grabBitmapFromCamera(viewTag)
                val maxDim = 512
                val srcW = rawBitmap.width
                val srcH = rawBitmap.height
                val scale = min(maxDim.toFloat() / srcW, maxDim.toFloat() / srcH)
                val targetW = (srcW * scale).toInt()
                val targetH = (srcH * scale).toInt()

                val scaledBitmap = Bitmap.createScaledBitmap(rawBitmap, targetW, targetH, true)
                val bos = ByteArrayOutputStream()
                scaledBitmap.compress(Bitmap.CompressFormat.JPEG, 85, bos)
                val bytes = bos.toByteArray()
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

                val result = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putString("base64", b64)
                    putInt("width", targetW)
                    putInt("height", targetH)
                    putInt("sizeBytes", bytes.size)
                }

                if (scaledBitmap != rawBitmap) {
                    scaledBitmap.recycle()
                }

                promise.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "capturePhotoFromCamera failed", e)
                promise.reject("CAPTURE_PHOTO_ERROR", "Failed to capture photo: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun saveReportFile(fileName: String, content: String, mimeType: String, promise: Promise) {
        scope.launch(Dispatchers.IO) {
            try {
                val resolver = reactContext.contentResolver
                val contentValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/Klasio"
                    )
                }

                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                if (uri == null) {
                    val file = File(reactContext.cacheDir, fileName)
                    file.writeText(content, Charsets.UTF_8)
                    promise.resolve(file.absolutePath)
                    return@launch
                }

                resolver.openOutputStream(uri)?.use { os ->
                    os.write(content.toByteArray(Charsets.UTF_8))
                }

                withContext(Dispatchers.Main) {
                    val shareIntent = Intent(Intent.ACTION_SEND).apply {
                        type = mimeType
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    val chooser = Intent.createChooser(shareIntent, "Share Attendance Report").apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    reactContext.startActivity(chooser)
                }

                promise.resolve(uri.toString())
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save report file", e)
                promise.reject("SAVE_FILE_ERROR", "Failed to save file: ${e.message}", e)
            }
        }
    }

    override fun invalidate() {
        super.invalidate()
        scope.cancel()
        recognizerSession?.close()
        ortSession?.close()
        ortEnv?.close()
    }
}

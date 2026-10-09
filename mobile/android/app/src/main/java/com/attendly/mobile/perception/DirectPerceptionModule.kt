package com.attendly.mobile.perception

import android.graphics.Bitmap
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.mrousavy.camera.react.CameraView
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
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
    private var currentModelName: String = "YuNet"
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

    @ReactMethod
    fun detectFacesInMemory(viewTag: Int, options: ReadableMap?, promise: Promise) {
        val totalStart = System.nanoTime()
        val captureTimestampMs = System.currentTimeMillis()
        val confThresh = (options?.getDouble("confidenceThreshold") ?: 0.35).toFloat()
        val targetDim = 640

        scope.launch {
            try {
                ensureOrtInitialized("YuNet")

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

    override fun invalidate() {
        super.invalidate()
        scope.cancel()
        ortSession?.close()
        ortEnv?.close()
    }
}

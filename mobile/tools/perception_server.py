"""
Replaceable Face Perception Worker Service
Attendly ML Laboratory / Perception Pipeline

Serves on-device / developer-bridge neural face detection for:
- YuNet (OpenCV 2023mar ONNX)
- SCRFD-500M (InsightFace ONNX)

Decouples preview resolution from ML analysis resolution (320x320 vs 640x640).
Provides real-time inference latency and detection metrics.
"""

import io
import time
import json
import logging
from typing import List, Dict, Any, Optional
import numpy as np
from PIL import Image
import onnxruntime as ort
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("perception-worker")

import os
from contextlib import asynccontextmanager

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YUNET_PATH = os.path.join(BASE_DIR, "src", "lab", "models", "yunet_2023mar.onnx")
EDGEFACE_PATH = os.path.join(BASE_DIR, "src", "lab", "models", "edgeface_xs.onnx")

CANONICAL_5PT = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_sessions()
    yield

app = FastAPI(title="Attendly Face Perception Worker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def init_sessions():
    global sess_yunet, sess_edgeface
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    logger.info("Initializing YuNet session from %s", YUNET_PATH)
    sess_yunet = ort.InferenceSession(YUNET_PATH, sess_options=opts, providers=["CPUExecutionProvider"])

    logger.info("Initializing EdgeFace-XS session from %s", EDGEFACE_PATH)
    sess_edgeface = ort.InferenceSession(EDGEFACE_PATH, sess_options=opts, providers=["CPUExecutionProvider"])
    logger.info("Perception & Embedding sessions loaded successfully.")


def nms(boxes: np.ndarray, scores: np.ndarray, thresh: float = 0.4) -> List[int]:
    """Pure numpy Non-Maximum Suppression."""
    if len(boxes) == 0:
        return []
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 0] + boxes[:, 2]
    y2 = boxes[:, 1] + boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        inds = np.where(ovr <= thresh)[0]
        order = order[inds + 1]
    return keep


def detect_yunet(image: Image.Image, target_w: int, target_h: int, conf_thresh: float) -> Dict[str, Any]:
    global sess_yunet
    t0 = time.perf_counter()

    # YuNet static graph constraint: yunet_2023mar.onnx requires exactly [1, 3, 640, 640]
    # If target resolution differs (e.g. 320x320), downsample first then place on 640x640 canvas
    if target_w != 640 or target_h != 640:
        low_res = image.resize((target_w, target_h), Image.Resampling.BILINEAR)
        resized = low_res.resize((640, 640), Image.Resampling.BILINEAR)
    else:
        resized = image.resize((640, 640), Image.Resampling.BILINEAR)
    arr = np.array(resized, dtype=np.float32)
    # HWC -> CHW -> NCHW
    arr = np.transpose(arr, (2, 0, 1))
    arr = np.expand_dims(arr, 0)

    # Run inference
    t_infer_0 = time.perf_counter()
    preprocess_latency_ms = (t_infer_0 - t0) * 1000.0
    out = sess_yunet.run(None, {"input": arr})
    t_infer_1 = time.perf_counter()
    inference_latency_ms = (t_infer_1 - t_infer_0) * 1000.0

    output_names = [o.name for o in sess_yunet.get_outputs()]
    out_dict = dict(zip(output_names, out))

    strides = [8, 16, 32]
    raw_boxes = []
    raw_scores = []
    raw_kps = []

    for stride in strides:
        cls_map = out_dict[f"cls_{stride}"][0]  # [N, 1]
        obj_map = out_dict[f"obj_{stride}"][0]  # [N, 1]
        bbox_map = out_dict[f"bbox_{stride}"][0]  # [N, 4]
        kps_map = out_dict[f"kps_{stride}"][0]  # [N, 10]

        scores = np.sqrt(np.maximum(cls_map * obj_map, 0.0))
        valid_idx = np.where(scores[:, 0] >= conf_thresh)[0]

        grid_w = 640 // stride
        for idx in valid_idx:
            c = idx % grid_w
            r = idx // grid_w
            cx = (c + bbox_map[idx, 0]) * stride
            cy = (r + bbox_map[idx, 1]) * stride
            w = np.exp(bbox_map[idx, 2]) * stride
            h = np.exp(bbox_map[idx, 3]) * stride
            x = cx - w / 2.0
            y = cy - h / 2.0
            raw_boxes.append([x, y, w, h])
            raw_scores.append(float(scores[idx, 0]))

            # 5 landmarks: right eye, left eye, nose, right mouth, left mouth
            landmarks = []
            for k in range(5):
                kx = (c + kps_map[idx, 2 * k]) * stride
                ky = (r + kps_map[idx, 2 * k + 1]) * stride
                landmarks.append([float(kx), float(ky)])
            raw_kps.append(landmarks)

    faces = []
    if len(raw_boxes) > 0:
        boxes_np = np.array(raw_boxes, dtype=np.float32)
        scores_np = np.array(raw_scores, dtype=np.float32)
        keep = nms(boxes_np, scores_np, thresh=0.4)

        for i, k_idx in enumerate(keep):
            bx, by, bw, bh = float(boxes_np[k_idx][0]), float(boxes_np[k_idx][1]), float(boxes_np[k_idx][2]), float(boxes_np[k_idx][3])
            conf = float(scores_np[k_idx])
            kps = raw_kps[k_idx]

            # Normalize coordinates relative to analysis frame [0.0, 1.0]
            norm_x = max(0.0, min(1.0, bx / float(target_w)))
            norm_y = max(0.0, min(1.0, by / float(target_h)))
            norm_w = max(0.0, min(1.0 - norm_x, bw / float(target_w)))
            norm_h = max(0.0, min(1.0 - norm_y, bh / float(target_h)))

            faces.append({
                "id": f"yunet_face_{i + 1}",
                "box": {
                    "x": float(round(norm_x, 4)),
                    "y": float(round(norm_y, 4)),
                    "width": float(round(norm_w, 4)),
                    "height": float(round(norm_h, 4)),
                },
                "confidence": float(round(conf, 4)),
                "landmarks": {
                    "rightEye": {"x": float(round(float(kps[0][0]) / target_w, 4)), "y": float(round(float(kps[0][1]) / target_h, 4))},
                    "leftEye": {"x": float(round(float(kps[1][0]) / target_w, 4)), "y": float(round(float(kps[1][1]) / target_h, 4))},
                    "noseTip": {"x": float(round(float(kps[2][0]) / target_w, 4)), "y": float(round(float(kps[2][1]) / target_h, 4))},
                    "rightMouth": {"x": float(round(float(kps[3][0]) / target_w, 4)), "y": float(round(float(kps[3][1]) / target_h, 4))},
                    "leftMouth": {"x": float(round(float(kps[4][0]) / target_w, 4)), "y": float(round(float(kps[4][1]) / target_h, 4))},
                },
            })

    t_post_end = time.perf_counter()
    postprocess_latency_ms = (t_post_end - t_infer_1) * 1000.0
    total_latency_ms = (t_post_end - t0) * 1000.0

    return {
        "success": True,
        "detector": "YuNet",
        "modelVersion": "2023mar",
        "preprocessLatencyMs": float(round(preprocess_latency_ms, 2)),
        "inferenceLatencyMs": float(round(inference_latency_ms, 2)),
        "postprocessLatencyMs": float(round(postprocess_latency_ms, 2)),
        "totalLatencyMs": float(round(total_latency_ms, 2)),
        "analysisResolution": {"width": int(target_w), "height": int(target_h)},
        "facesCount": int(len(faces)),
        "faces": faces,
    }


@app.get("/health")
def health():
    return {
        "status": "online",
        "service": "Attendly Replaceable Perception Worker",
        "deviceTarget": "Motorola Moto G54 5G",
        "models": {
            "YuNet": {"loaded": sess_yunet is not None, "path": YUNET_PATH},
            "EdgeFace-XS": {"loaded": sess_edgeface is not None, "path": EDGEFACE_PATH},
        },
    }


@app.post("/detect")
async def detect(
    file: UploadFile = File(...),
    detector: str = Form("YuNet"),
    analysisWidth: int = Form(640),
    analysisHeight: int = Form(640),
    confidenceThreshold: float = Form(0.4),
    frameId: Optional[str] = Form(None),
    captureTimestamp: Optional[float] = Form(None),
):
    t_req_start = time.perf_counter()
    try:
        contents = await file.read()
        t_after_read = time.perf_counter()
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        t_after_decode = time.perf_counter()
    except Exception as e:
        logger.error("Failed to decode uploaded image: %s", e)
        raise HTTPException(status_code=400, detail=f"Image decoding failed: {str(e)}")

    read_bytes_ms = (t_after_read - t_req_start) * 1000.0
    decode_img_ms = (t_after_decode - t_after_read) * 1000.0

    if detector == "YuNet":
        res = detect_yunet(image, analysisWidth, analysisHeight, confidenceThreshold)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported detector candidate: {detector}")

    t_req_end = time.perf_counter()
    total_server_ms = (t_req_end - t_req_start) * 1000.0

    res["frameId"] = frameId
    res["captureTimestamp"] = captureTimestamp
    res["serverReceivedTimestampMs"] = float(round(time.time() * 1000.0, 2))
    res["serverCompletedTimestampMs"] = float(round(time.time() * 1000.0, 2))

    res["timings"] = {
        "payloadReadMs": float(round(read_bytes_ms, 2)),
        "decodeImageMs": float(round(decode_img_ms, 2)),
        "preprocessMs": float(round(res.get("preprocessLatencyMs", 0.0), 2)),
        "onnxInferenceMs": float(round(res.get("inferenceLatencyMs", 0.0), 2)),
        "postprocessMs": float(round(res.get("postprocessLatencyMs", 0.0), 2)),
        "totalServerMs": float(round(total_server_ms, 2)),
    }

    logger.info(
        "[%s %dx%d] Read: %.1fms | Dec: %.1fms | Pre: %.1fms | Infer: %.1fms | Post: %.1fms | SrvTot: %.1fms | Faces: %d",
        detector,
        analysisWidth,
        analysisHeight,
        read_bytes_ms,
        decode_img_ms,
        res.get("preprocessLatencyMs", 0.0),
        res.get("inferenceLatencyMs", 0.0),
        res.get("postprocessLatencyMs", 0.0),
        total_server_ms,
        res["facesCount"],
    )
    return res


@app.get("/health_check")
def health_check():
    return {
        "status": "ok",
        "detectors": ["YuNet"],
        "embedders": ["EdgeFace-XS"],
        "timestamp": time.time(),
    }


@app.post("/embed")
async def embed_endpoint(
    file: UploadFile = File(...),
    model: str = Form("EdgeFace-XS"),
    align: bool = Form(True),
    landmarksJson: Optional[str] = Form(None),
):
    t0 = time.perf_counter()
    contents = await file.read()
    image = Image.open(io.BytesIO(contents)).convert("RGB")
    img_np = np.array(image)

    align_mode = "NONE"
    if align and landmarksJson:
        try:
            lms_dict = json.loads(landmarksJson)
            src_pts = np.array([
                [lms_dict["leftEye"]["x"], lms_dict["leftEye"]["y"]],
                [lms_dict["rightEye"]["x"], lms_dict["rightEye"]["y"]],
                [lms_dict["noseTip"]["x"], lms_dict["noseTip"]["y"]],
                [lms_dict["mouthLeft"]["x"], lms_dict["mouthLeft"]["y"]],
                [lms_dict["mouthRight"]["x"], lms_dict["mouthRight"]["y"]],
            ], dtype=np.float32)
            M, _ = cv2.estimateAffinePartial2D(src_pts, CANONICAL_5PT, method=cv2.LMEDS)
            if M is not None:
                crop_112 = cv2.warpAffine(img_np, M, (112, 112))
                align_mode = "SIMILARITY_TRANSFORM_5PT"
            else:
                crop_112 = cv2.resize(img_np, (112, 112))
        except Exception:
            crop_112 = cv2.resize(img_np, (112, 112))
    else:
        crop_112 = cv2.resize(img_np, (112, 112))

    t1 = time.perf_counter()
    crop_ms = (t1 - t0) * 1000.0

    if model == "EdgeFace-XS":
        normed = (crop_112.astype(np.float32) - 127.5) / 128.0
        sess = sess_edgeface
        input_name = sess.get_inputs()[0].name
        output_name = sess.get_outputs()[0].name
        norm_mode = "MINUS_127_5_DIV_128_0"
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported model: {model}")

    tensor = np.transpose(normed, (2, 0, 1))
    tensor = np.expand_dims(tensor, axis=0)
    t2 = time.perf_counter()
    preproc_ms = (t2 - t1) * 1000.0

    raw_vec = sess.run([output_name], {input_name: tensor})[0].flatten()
    t3 = time.perf_counter()
    infer_ms = (t3 - t2) * 1000.0

    norm = float(np.linalg.norm(raw_vec))
    unit_vec = (raw_vec / norm).tolist() if norm > 1e-12 else raw_vec.tolist()
    t4 = time.perf_counter()
    norm_ms = (t4 - t3) * 1000.0
    total_ms = (t4 - t0) * 1000.0

    return {
        "success": True,
        "model": model,
        "embeddingDimension": len(unit_vec),
        "alignmentMode": align_mode,
        "normalization": norm_mode,
        "isNormalized": True,
        "timings": {
            "cropMs": float(round(crop_ms, 2)),
            "preprocessMs": float(round(preproc_ms, 2)),
            "inferenceMs": float(round(infer_ms, 2)),
            "normalizeMs": float(round(norm_ms, 2)),
            "totalMs": float(round(total_ms, 2)),
        },
        "embedding": unit_vec,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8998, log_level="info")

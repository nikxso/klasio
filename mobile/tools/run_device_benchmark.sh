#!/usr/bin/env bash
# ==============================================================================
# Attendly Phase 10: Layer A — On-Device Benchmark Orchestration Script
# Target Device: Motorola Moto G54 5G (cancunf, Dimensity 7020, Android 15 / API 35)
# Evidence Tag: [DEVICE-MEASURED]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTPUT_JSON="${SCRIPT_DIR}/device_benchmark_results.json"
CONSOLE_LOG="${SCRIPT_DIR}/device_benchmark_console.log"

echo "=================================================================="
echo "  ATTENDLY ON-DEVICE EMPIRICAL BENCHMARK ORCHESTRATOR"
echo "  Target Device: Motorola Moto G54 5G (Dimensity 7020 / Android 15)"
echo "  Evidence Classification: [DEVICE-MEASURED]"
echo "=================================================================="

# 1. Verify ADB Connectivity
echo "[1/5] Verifying ADB connectivity..."
if ! command -v adb >/dev/null 2>&1; then
    echo "ERROR: adb command not found in PATH." >&2
    exit 1
fi

DEVICES=$(adb devices | grep -w "device" | awk '{print $1}')
if [ -z "${DEVICES}" ]; then
    echo "ERROR: No authorized ADB device detected. Connect Motorola Moto G54 5G and enable USB debugging." >&2
    exit 1
fi

DEVICE_ID=$(echo "${DEVICES}" | head -n 1)
echo "      Detected ADB device: ${DEVICE_ID}"

# 2. Inspect Target Device Hardware Profile
echo "[2/5] Inspecting device properties..."
DEVICE_MODEL=$(adb -s "${DEVICE_ID}" shell getprop ro.product.model | tr -d '\r\n')
DEVICE_NAME=$(adb -s "${DEVICE_ID}" shell getprop ro.product.device | tr -d '\r\n')
BOARD_PLATFORM=$(adb -s "${DEVICE_ID}" shell getprop ro.board.platform | tr -d '\r\n')
ANDROID_VERSION=$(adb -s "${DEVICE_ID}" shell getprop ro.build.version.release | tr -d '\r\n')
SDK_API=$(adb -s "${DEVICE_ID}" shell getprop ro.build.version.sdk | tr -d '\r\n')
CPU_ABI=$(adb -s "${DEVICE_ID}" shell getprop ro.product.cpu.abi | tr -d '\r\n')

echo "      Model:       ${DEVICE_MODEL}"
echo "      Device Code: ${DEVICE_NAME}"
echo "      Platform:    ${BOARD_PLATFORM}"
echo "      Android OS:  ${ANDROID_VERSION} (API ${SDK_API})"
echo "      CPU ABI:     ${CPU_ABI}"

# 3. Verify Remote Assets in /data/local/tmp/atten_lab/
echo "[3/5] Verifying on-device benchmark assets in /data/local/tmp/atten_lab/..."
REMOTE_DIR="/data/local/tmp/atten_lab"
REMOTE_MODELS="${REMOTE_DIR}/models"
REMOTE_LIB="${REMOTE_DIR}/lib"
REMOTE_DEX="${REMOTE_DIR}/bench.dex"

check_remote_file() {
    local file_path="$1"
    if ! adb -s "${DEVICE_ID}" shell "[ -f ${file_path} ]"; then
        echo "ERROR: Required remote file missing: ${file_path}" >&2
        exit 1
    fi
}

check_remote_file "${REMOTE_DEX}"
check_remote_file "${REMOTE_LIB}/libonnxruntime.so"
check_remote_file "${REMOTE_LIB}/libonnxruntime4j_jni.so"
check_remote_file "${REMOTE_MODELS}/yunet_2023mar.onnx"
check_remote_file "${REMOTE_MODELS}/det_500m.onnx"
check_remote_file "${REMOTE_MODELS}/w600k_mbf.onnx"
check_remote_file "${REMOTE_MODELS}/edgeface_xs.onnx"
echo "      All on-device DEX, native libraries, and ONNX models verified."

# 4. Execute Native ART DEX Benchmark
echo "[4/5] Executing DeviceBenchmarkRunner via dalvikvm on Moto G54 5G..."
EXEC_CMD="LD_LIBRARY_PATH=${REMOTE_LIB} dalvikvm -cp ${REMOTE_DEX} DeviceBenchmarkRunner ${REMOTE_MODELS}"
adb -s "${DEVICE_ID}" shell "${EXEC_CMD}" | tee "${CONSOLE_LOG}"

# 5. Parse Output into Structured JSON
echo "[5/5] Parsing raw metrics and generating ${OUTPUT_JSON}..."

python3 - <<EOF
import re
import json
import os
import datetime

log_file = "${CONSOLE_LOG}"
out_file = "${OUTPUT_JSON}"

with open(log_file, "r") as f:
    text = f.read()

def extract_metric(pattern, text, default=0.0):
    m = re.search(pattern, text)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return m.group(1).strip()
    return default

# Extract detectors
yunet_block = text[text.find("Benchmarking Detector: YuNet"):text.find("Benchmarking Detector: SCRFD-500M")]
scrfd_block = text[text.find("Benchmarking Detector: SCRFD-500M"):text.find("PHASE 4:")]

# Extract recognizers
mbf_block = text[text.find("Benchmarking Recognizer: MobileFaceNet"):text.find("Benchmarking Recognizer: EdgeFace-XS")]
edgeface_block = text[text.find("Benchmarking Recognizer: EdgeFace-XS"):text.find("[DONE]")]

results = {
    "evidence_classification": "[DEVICE-MEASURED]",
    "metadata": {
        "benchmark_run_id": f"RUN-DEVICE-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')}",
        "timestamp_iso": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "device_target": "${DEVICE_MODEL} (${DEVICE_NAME}, ${BOARD_PLATFORM})",
        "android_version": "${ANDROID_VERSION}",
        "android_api": int("${SDK_API}"),
        "cpu_abi": "${CPU_ABI}",
        "device_id": "${DEVICE_ID}",
        "execution_engine": "Android ART dalvikvm + native libonnxruntime.so (arm64-v8a)"
    },
    "detectors": {
        "YuNet_2023mar": {
            "evidence_tag": "[DEVICE-MEASURED]",
            "model_size_kb": extract_metric(r"Model size:\s+([\d\.]+)\s+KB", yunet_block),
            "input_resolution": "320x320",
            "init_time_ms": extract_metric(r"Initialization time:\s+(\d+)\s+ms", yunet_block),
            "cold_latency_ms": extract_metric(r"Cold inference latency:\s+(\d+)\s+ms", yunet_block),
            "iterations": int(extract_metric(r"Iterations:\s+(\d+)\s+runs", yunet_block, 30)),
            "mean_latency_ms": extract_metric(r"Mean Latency:\s+([\d\.]+)\s+ms", yunet_block),
            "throughput_fps": extract_metric(r"Throughput:\s+([\d\.]+)\s+FPS", yunet_block),
            "median_latency_ms": extract_metric(r"Median:\s+([\d\.]+)\s+ms", yunet_block),
            "min_latency_ms": extract_metric(r"Min / Max:\s+([\d\.]+)\s+ms", yunet_block),
            "max_latency_ms": extract_metric(r"Min / Max:\s+[\d\.]+\s+ms\s+/\s+([\d\.]+)\s+ms", yunet_block),
            "p95_latency_ms": extract_metric(r"P95 Latency:\s+([\d\.]+)\s+ms", yunet_block),
            "process_rss_mb": extract_metric(r"Process RSS:\s+\d+\s+KB\s+\(([\d\.]+)\s+MB\)", yunet_block)
        },
        "SCRFD_500M": {
            "evidence_tag": "[DEVICE-MEASURED]",
            "model_size_mb": extract_metric(r"Model size:\s+([\d\.]+)\s+MB", scrfd_block),
            "input_resolution": "640x640",
            "init_time_ms": extract_metric(r"Initialization time:\s+(\d+)\s+ms", scrfd_block),
            "cold_latency_ms": extract_metric(r"Cold inference latency:\s+(\d+)\s+ms", scrfd_block),
            "iterations": int(extract_metric(r"Iterations:\s+(\d+)\s+runs", scrfd_block, 30)),
            "mean_latency_ms": extract_metric(r"Mean Latency:\s+([\d\.]+)\s+ms", scrfd_block),
            "throughput_fps": extract_metric(r"Throughput:\s+([\d\.]+)\s+FPS", scrfd_block),
            "median_latency_ms": extract_metric(r"Median:\s+([\d\.]+)\s+ms", scrfd_block),
            "min_latency_ms": extract_metric(r"Min / Max:\s+([\d\.]+)\s+ms", scrfd_block),
            "max_latency_ms": extract_metric(r"Min / Max:\s+[\d\.]+\s+ms\s+/\s+([\d\.]+)\s+ms", scrfd_block),
            "p95_latency_ms": extract_metric(r"P95 Latency:\s+([\d\.]+)\s+ms", scrfd_block),
            "process_rss_mb": extract_metric(r"Process RSS:\s+\d+\s+KB\s+\(([\d\.]+)\s+MB\)", scrfd_block)
        }
    },
    "recognizers": {
        "MobileFaceNet": {
            "evidence_tag": "[DEVICE-MEASURED]",
            "model_size_mb": extract_metric(r"Model size:\s+([\d\.]+)\s+MB", mbf_block),
            "input_resolution": "112x112",
            "init_time_ms": extract_metric(r"Initialization time:\s+(\d+)\s+ms", mbf_block),
            "cold_latency_ms": extract_metric(r"Cold inference latency:\s+(\d+)\s+ms", mbf_block),
            "embedding_dim": int(extract_metric(r"Verified embedding dimension:\s+(\d+)-dim", mbf_block, 512)),
            "raw_l2_norm": extract_metric(r"Raw vector L2 norm:\s+([\d\.]+)", mbf_block),
            "iterations": int(extract_metric(r"Iterations:\s+(\d+)\s+runs", mbf_block, 50)),
            "mean_latency_ms": extract_metric(r"Mean Latency:\s+([\d\.]+)\s+ms", mbf_block),
            "throughput_fps": extract_metric(r"Throughput:\s+([\d\.]+)\s+FPS", mbf_block),
            "median_latency_ms": extract_metric(r"Median:\s+([\d\.]+)\s+ms", mbf_block),
            "min_latency_ms": extract_metric(r"Min / Max:\s+([\d\.]+)\s+ms", mbf_block),
            "max_latency_ms": extract_metric(r"Min / Max:\s+[\d\.]+\s+ms\s+/\s+([\d\.]+)\s+ms", mbf_block),
            "p95_latency_ms": extract_metric(r"P95 Latency:\s+([\d\.]+)\s+ms", mbf_block),
            "process_rss_mb": extract_metric(r"Process RSS:\s+\d+\s+KB\s+\(([\d\.]+)\s+MB\)", mbf_block),
            "batch_scaling": {
                "5_faces_batch_ms": extract_metric(r"5 faces sequential batch:\s+([\d\.]+)\s+ms", mbf_block),
                "5_faces_per_face_ms": extract_metric(r"5 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", mbf_block),
                "10_faces_batch_ms": extract_metric(r"10 faces sequential batch:\s+([\d\.]+)\s+ms", mbf_block),
                "10_faces_per_face_ms": extract_metric(r"10 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", mbf_block),
                "20_faces_batch_ms": extract_metric(r"20 faces sequential batch:\s+([\d\.]+)\s+ms", mbf_block),
                "20_faces_per_face_ms": extract_metric(r"20 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", mbf_block)
            }
        },
        "EdgeFace_XS": {
            "evidence_tag": "[DEVICE-MEASURED]",
            "model_size_mb": extract_metric(r"Model size:\s+([\d\.]+)\s+MB", edgeface_block),
            "input_resolution": "112x112",
            "init_time_ms": extract_metric(r"Initialization time:\s+(\d+)\s+ms", edgeface_block),
            "cold_latency_ms": extract_metric(r"Cold inference latency:\s+(\d+)\s+ms", edgeface_block),
            "embedding_dim": int(extract_metric(r"Verified embedding dimension:\s+(\d+)-dim", edgeface_block, 512)),
            "raw_l2_norm": extract_metric(r"Raw vector L2 norm:\s+([\d\.]+)", edgeface_block),
            "iterations": int(extract_metric(r"Iterations:\s+(\d+)\s+runs", edgeface_block, 50)),
            "mean_latency_ms": extract_metric(r"Mean Latency:\s+([\d\.]+)\s+ms", edgeface_block),
            "throughput_fps": extract_metric(r"Throughput:\s+([\d\.]+)\s+FPS", edgeface_block),
            "median_latency_ms": extract_metric(r"Median:\s+([\d\.]+)\s+ms", edgeface_block),
            "min_latency_ms": extract_metric(r"Min / Max:\s+([\d\.]+)\s+ms", edgeface_block),
            "max_latency_ms": extract_metric(r"Min / Max:\s+[\d\.]+\s+ms\s+/\s+([\d\.]+)\s+ms", edgeface_block),
            "p95_latency_ms": extract_metric(r"P95 Latency:\s+([\d\.]+)\s+ms", edgeface_block),
            "process_rss_mb": extract_metric(r"Process RSS:\s+\d+\s+KB\s+\(([\d\.]+)\s+MB\)", edgeface_block),
            "batch_scaling": {
                "5_faces_batch_ms": extract_metric(r"5 faces sequential batch:\s+([\d\.]+)\s+ms", edgeface_block),
                "5_faces_per_face_ms": extract_metric(r"5 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", edgeface_block),
                "10_faces_batch_ms": extract_metric(r"10 faces sequential batch:\s+([\d\.]+)\s+ms", edgeface_block),
                "10_faces_per_face_ms": extract_metric(r"10 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", edgeface_block),
                "20_faces_batch_ms": extract_metric(r"20 faces sequential batch:\s+([\d\.]+)\s+ms", edgeface_block),
                "20_faces_per_face_ms": extract_metric(r"20 faces sequential batch:\s+[\d\.]+\s+ms\s+\(([\d\.]+)\s+ms/face", edgeface_block)
            }
        }
    }
}

with open(out_file, "w") as f:
    json.dump(results, f, indent=2)

print(f"[SUCCESS] On-device benchmark results saved to {out_file}")
EOF

echo "=================================================================="
echo "  ON-DEVICE BENCHMARK RUN COMPLETE: ${OUTPUT_JSON}"
echo "=================================================================="

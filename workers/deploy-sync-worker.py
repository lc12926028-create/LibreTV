#!/usr/bin/env python3
"""部署 LibreTV 同步 Worker 到 Cloudflare（复用 cf.py 的凭据注入方式）。

用法：
  python3 deploy-sync-worker.py <account_id> <d1_database_id> <sync_code> [script_name]
默认 script_name = libretv-sync。
注意：sync_code 以参数传入，不写进仓库，避免提交到 GitHub。
"""
import json
import mimetypes
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT = sys.argv[1]
D1_ID = sys.argv[2]
SYNC_CODE = sys.argv[3]
SCRIPT = sys.argv[4] if len(sys.argv) > 4 else "libretv-sync"

WORKER_PATH = "/home/hatch/workspace/repos/libretv/workers/libretv-sync-worker.js"
with open(WORKER_PATH, "rb") as f:
    code = f.read()

metadata = {
    "main_module": "worker.js",
    "bindings": [
        {"type": "d1", "name": "SYNC_DB", "id": D1_ID},
        {"type": "plain_text", "name": "SYNC_CODE", "text": SYNC_CODE},
    ],
    "compatibility_date": "2024-01-01",
    # API 部署默认不启用 workers.dev 路由，必须显式打开，否则报 1042
    "workers_dev": True,
}

# multipart/form-data（metadata + worker.js）
boundary = "----libretv-sync-deploy"
parts = []
parts.append(
    b"--" + boundary.encode() + b"\r\n"
    b'Content-Disposition: form-data; name="metadata"\r\n'
    b"Content-Type: application/json\r\n\r\n"
    + json.dumps(metadata).encode()
    + b"\r\n"
)
parts.append(
    b"--" + boundary.encode() + b"\r\n"
    b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
    b"Content-Type: application/javascript+module\r\n\r\n"
    + code
    + b"\r\n"
)
parts.append(b"--" + boundary.encode() + b"--\r\n")
body = b"".join(parts)

req = urllib.request.Request(
    f"{BASE}/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
    data=body,
    method="PUT",
)
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
with urllib.request.build_opener().open(req, timeout=60) as resp:
    result = read_json_response(resp)
print(json.dumps(result, indent=1, ensure_ascii=False))
if not result.get("success"):
    sys.exit(1)
print(f"\nWorker 已部署：{SCRIPT}")
print("默认访问地址形如：https://" + SCRIPT + ".<你的 workers.dev 子域>.workers.dev")

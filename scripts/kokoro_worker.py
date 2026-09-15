import base64
import contextlib
import json
import os
import sys

import numpy as np
import torch
from kokoro import KPipeline

torch.set_num_threads(int(os.environ.get("LOCAL_THREADS", "4")))
voice = os.environ.get("KOKORO_VOICE", "af_heart")
with contextlib.redirect_stdout(sys.stderr):
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cpu")
    list(pipeline("Ready.", voice=voice))
print(json.dumps({"type": "ready"}), flush=True)

for line in sys.stdin:
    if not line.strip():
        continue
    request = {}
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            chunks = pipeline(str(request.get("text", ""))[:500], voice=voice)
            for _, _, audio in chunks:
                if audio is None:
                    continue
                samples = audio.detach().cpu().numpy() if isinstance(audio, torch.Tensor) else np.asarray(audio)
                pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                event = {"id": request["id"], "type": "audio", "data": base64.b64encode(pcm).decode("ascii"), "sampleRate": 24000}
                sys.__stdout__.write(json.dumps(event) + "\n")
                sys.__stdout__.flush()
    except Exception as error:
        print(json.dumps({"id": request.get("id"), "type": "error", "error": str(error)[:300]}), flush=True)
    print(json.dumps({"id": request.get("id"), "type": "done"}), flush=True)#!/usr/bin/env python3
"""
Kokoro-82M TTS Worker for Voice Supervisor.
Persistent process reading JSONL from stdin and writing JSONL audio chunks to stdout.
"""

import sys
import os
import json
import base64

threads = int(os.environ.get("LOCAL_THREADS", "4"))

try:
    import torch
    torch.set_num_threads(threads)
except Exception as e:
    sys.stderr.write(f"Failed to configure torch threads ({threads}): {e}\n")
    sys.stderr.flush()

try:
    import numpy as np
    from kokoro import KPipeline
except ImportError as e:
    sys.stderr.write(f"FATAL: Missing kokoro dependencies: {e}\n")
    sys.stderr.write("Install required packages with: pip install -r requirements-local.txt\n")
    sys.stderr.flush()
    sys.exit(1)

voice = os.environ.get("KOKORO_VOICE", "af_heart")

try:
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
except Exception as e:
    sys.stderr.write(f"FATAL: Failed to initialize Kokoro KPipeline: {e}\n")
    sys.stderr.flush()
    sys.exit(1)

sys.stdout.write(json.dumps({"type": "ready"}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        req = json.loads(line)
    except Exception as e:
        sys.stderr.write(f"Malformed JSON on stdin: {e}\n"[:300])
        sys.stderr.flush()
        continue

    req_id = req.get("id")
    text = (req.get("text") or "").strip()

    if not text:
        sys.stdout.write(json.dumps({"id": req_id, "type": "done"}) + "\n")
        sys.stdout.flush()
        continue

    try:
        generator = pipeline(text, voice=voice, speed=1.0, split_pattern=r"\n+")
        for _, _, audio in generator:
            if audio is None:
                continue
            if isinstance(audio, torch.Tensor):
                audio = audio.detach().cpu().numpy()
            elif not isinstance(audio, np.ndarray):
                audio = np.array(audio, dtype=np.float32)

            audio = np.clip(audio, -1.0, 1.0)
            pcm16 = (audio * 32767.0).astype(np.int16)
            b64_audio = base64.b64encode(pcm16.tobytes()).decode("ascii")

            chunk = {
                "id": req_id,
                "type": "audio",
                "data": b64_audio,
                "sampleRate": 24000
            }
            sys.stdout.write(json.dumps(chunk) + "\n")
            sys.stdout.flush()

        sys.stdout.write(json.dumps({"id": req_id, "type": "done"}) + "\n")
        sys.stdout.flush()
    except Exception as e:
        err_msg = str(e)[:400]
        sys.stderr.write(f"Kokoro synthesis error for req {req_id}: {err_msg}\n")
        sys.stderr.flush()
        sys.stdout.write(json.dumps({"id": req_id, "type": "error", "error": err_msg}) + "\n")
        sys.stdout.write(json.dumps({"id": req_id, "type": "done"}) + "\n")
        sys.stdout.flush()

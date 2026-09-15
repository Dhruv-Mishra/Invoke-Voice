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
repo = os.environ.get("KOKORO_REPO", "hexgrad/Kokoro-82M")
with contextlib.redirect_stdout(sys.stderr):
    pipeline = KPipeline(lang_code="a", repo_id=repo, device="cpu")
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
    print(json.dumps({"id": request.get("id"), "type": "done"}), flush=True)
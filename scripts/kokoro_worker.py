import base64
import contextlib
import json
import math
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np
import torch
import spacy.util
from kokoro import KModel, KPipeline

torch.set_num_threads(int(os.environ.get("LOCAL_THREADS", "4")))
voice = os.environ.get("KOKORO_VOICE", "af_heart")
repo = os.environ.get("KOKORO_REPO", "hexgrad/Kokoro-82M")
if not spacy.util.is_package("en_core_web_sm"):
    raise RuntimeError("English speech dependencies are missing. Run local setup in Settings.")
with contextlib.redirect_stdout(sys.stderr):
    local_dir = os.environ.get("KOKORO_LOCAL_DIR")
    if local_dir:
        model = KModel(repo_id=repo, config=os.path.join(local_dir, "config.json"), model=os.path.join(local_dir, "kokoro-v1_0.pth")).to("cpu").eval()
        voice = os.path.join(local_dir, "af_heart.pt")
        pipeline = KPipeline(lang_code="a", repo_id=repo, model=model, device="cpu")
    else:
        pipeline = KPipeline(lang_code="a", repo_id=repo, device="cpu")
    list(pipeline("Ready.", voice=voice))
print(json.dumps({"type": "ready"}), flush=True)

def bounded_number(value, lower, upper):
    try:
        number = float(value)
        return min(upper, max(lower, number)) if math.isfinite(number) else 1.0
    except (TypeError, ValueError):
        return 1.0


for line in sys.stdin:
    if not line.strip():
        continue
    request = {}
    try:
        request = json.loads(line)
        selected_voice = voice
        voice_name = request.get("voice")
        if local_dir and voice_name in ("am_michael", "am_fenrir"):
            candidate = os.path.join(local_dir, voice_name + ".pt")
            if os.path.isfile(candidate):
                selected_voice = candidate
        speed = bounded_number(request.get("speed", 1), 0.85, 1.2)
        pitch = bounded_number(request.get("pitch", 1), 0.85, 1.15)
        with contextlib.redirect_stdout(sys.stderr):
            chunks = pipeline(str(request.get("text", ""))[:500], voice=selected_voice, speed=speed)
            for _, _, audio in chunks:
                if audio is None:
                    continue
                samples = audio.detach().cpu().numpy() if isinstance(audio, torch.Tensor) else np.asarray(audio)
                if pitch != 1.0 and samples.size > 1:
                    samples = np.interp(np.arange(0, samples.size - 1, pitch), np.arange(samples.size), samples)
                pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                event = {"id": request["id"], "type": "audio", "data": base64.b64encode(pcm).decode("ascii"), "sampleRate": 24000}
                sys.__stdout__.write(json.dumps(event) + "\n")
                sys.__stdout__.flush()
    except Exception as error:
        print(json.dumps({"id": request.get("id"), "type": "error", "error": str(error)[:300]}), flush=True)
    print(json.dumps({"id": request.get("id"), "type": "done"}), flush=True)
"""Root-deployed private CPU STT spike; importing/deploying this is not a test.

Root must provision private volumes/secret separately and ensure one writer,
including no overlapping old/new deployment. No resources are auto-created.
No audio is written to disk or logged; model weights download only at runtime
into the private cache Volume. The private journal contains transcripts.

Decoded PCM is capped before Whisper inference. Native PyAV/FFmpeg may allocate
a frame before Python can inspect it; the 2GiB request and 120s function timeout
are resource configuration, not adversarial decoder containment or hard limits
on each native call. Timeout/termination leaves ENTERED, blocking unsafe replay.
"""

import io
import logging
import os
from pathlib import Path
import sys
import time

import modal

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stt_protocol import (DecodedAudio, FileJournal, MAX_ENCODED_BYTES,
    MAX_SAMPLES, MAX_TRANSCRIPT_CHARS, MODEL_REPOSITORY, MODEL_REVISION,
    ProtocolError, SAMPLE_RATE, TranscriptionService, authenticate,
    media_type, validate_request_id)

PYTHON_VERSION = "3.12.11"
PACKAGES = ("faster-whisper==1.2.1", "ctranslate2==4.6.0", "av==16.0.1",
            "numpy==2.2.6", "huggingface-hub==0.36.0", "fastapi==0.115.12")
app = modal.App("o-phone-stt-spike-20261004")
cache = modal.Volume.from_name("o-phone-stt-private-model-cache-20261004", create_if_missing=False)
journal_volume = modal.Volume.from_name("o-phone-stt-private-journal-20261004", create_if_missing=False)
secret = modal.Secret.from_name("o-phone-stt-private-auth-20261004", required_keys=["O_STT_BEARER_TOKEN"])
image = (modal.Image.debian_slim(python_version=PYTHON_VERSION).pip_install(*PACKAGES)
    .add_local_file(Path(__file__).with_name("stt_protocol.py"), "/opt/o/stt_protocol.py", copy=True)
    .env({"PYTHONPATH": "/opt/o", "HF_HOME": "/model-cache/huggingface",
          "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1"}))


def bounded_decode(body, content_type):
    import av
    import numpy as np

    formats = {"audio/webm": "matroska", "audio/ogg": "ogg", "audio/mp4": "mov", "audio/wav": "wav"}
    deadline = time.monotonic() + 10
    output = bytearray()
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(io.BytesIO(body), mode="r", format=formats[content_type],
                 options={"protocol_whitelist": "pipe"}, metadata_errors="strict") as container:
        audio_streams = list(container.streams.audio)
        if len(audio_streams) != 1 or len(container.streams.video) != 0:
            raise ValueError("Single audio stream required")
        stream = audio_streams[0]
        if stream.duration is not None and stream.time_base is not None:
            if float(stream.duration * stream.time_base) > 30:
                raise ValueError("Decoded duration bound")
        decoded_seconds = 0.0

        def append_frames(frames):
            for frame in frames:
                if time.monotonic() > deadline or frame.samples > MAX_SAMPLES:
                    raise ValueError("Decoder bound")
                if len(output) + frame.samples * 2 > MAX_SAMPLES * 2:
                    raise ValueError("Decoded sample bound")
                # Convert only after each native frame and aggregate sample bound.
                output.extend(frame.to_ndarray().astype("<i2", copy=False).tobytes())
                if len(output) > MAX_SAMPLES * 2:
                    raise ValueError("Decoded byte bound")

        for frame in container.decode(stream):
            if (time.monotonic() > deadline or frame.samples > 192000
                    or not 8000 <= frame.sample_rate <= 192000 or len(frame.layout.channels) > 2):
                raise ValueError("Native audio frame bound")
            decoded_seconds += frame.samples / frame.sample_rate
            if decoded_seconds > 30:
                raise ValueError("Decoded duration bound")
            append_frames(resampler.resample(frame))
        append_frames(resampler.resample(None))
    if not output or len(output) % 2 or time.monotonic() > deadline:
        raise ValueError("Invalid decoded audio")
    samples = np.frombuffer(output, dtype="<i2").astype(np.float32) / 32768.0
    return DecodedAudio(samples, int(samples.size))


@app.function(image=image, cpu=2, memory=2048, timeout=120,
              min_containers=0, max_containers=1, scaledown_window=60,
              volumes={"/model-cache": cache, "/journal": journal_volume}, secrets=[secret])
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def endpoint():
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    # Disable payload-bearing library/access logs; no raw exception is returned.
    for name in ("faster_whisper", "av", "httpx", "huggingface_hub", "uvicorn.access"):
        logging.getLogger(name).disabled = True
    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    journal = FileJournal("/journal/requests", journal_volume.commit)
    loaded_model = None

    def infer(samples):
        nonlocal loaded_model
        if loaded_model is None:
            from huggingface_hub import snapshot_download
            from faster_whisper import WhisperModel
            path = snapshot_download(repo_id=MODEL_REPOSITORY, revision=MODEL_REVISION,
                cache_dir="/model-cache/huggingface", allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"])
            cache.commit()
            loaded_model = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=2,
                                       num_workers=1, local_files_only=True)
        segments, info = loaded_model.transcribe(samples, language=None, task="transcribe",
            beam_size=1, best_of=1, temperature=0.0, condition_on_previous_text=False,
            vad_filter=False, max_new_tokens=256, initial_prompt=None, word_timestamps=False,
            log_progress=False)
        parts, units = [], 0
        for index, segment in enumerate(segments):
            if index >= 32 or not isinstance(segment.text, str):
                raise ValueError("Transcript bound")
            units += len(segment.text.encode("utf-16-le")) // 2
            if units > MAX_TRANSCRIPT_CHARS:
                raise ValueError("Transcript bound")
            parts.append(segment.text)
        return "".join(parts).strip(), info.language

    service = TranscriptionService(journal, bounded_decode, infer)

    @web.post("/transcribe")
    async def transcribe(request: Request):
        request_id = None
        try:
            authenticate(request.headers.get("authorization"), os.environ.get("O_STT_BEARER_TOKEN"))
            request_id = validate_request_id(request.headers.get("x-o-voice-request-id"))
            kind = media_type(request.headers.get("content-type"))
            if request.headers.get("content-encoding", "identity").lower() != "identity":
                raise ProtocolError(415, "UNSUPPORTED_CONTENT_ENCODING")
            length = request.headers.get("content-length")
            if length is not None:
                if not length.isascii() or not length.isdecimal():
                    raise ProtocolError(400, "INVALID_CONTENT_LENGTH")
                if int(length) > MAX_ENCODED_BYTES:
                    raise ProtocolError(413, "AUDIO_TOO_LARGE")
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_ENCODED_BYTES:
                    raise ProtocolError(413, "AUDIO_TOO_LARGE")
                body.extend(chunk)
            if length is not None and int(length) != len(body):
                raise ProtocolError(400, "CONTENT_LENGTH_MISMATCH")
            result = service.process(request_id, kind, bytes(body))
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except ProtocolError as error:
            if error.request_id is None:
                error.request_id = request_id
            return JSONResponse(error.payload(), status_code=error.status, headers={"Cache-Control": "no-store"})
        except BaseException:
            # An interrupted stream did not enter ASR; caller still cannot retry automatically.
            error = ProtocolError(503, "REQUEST_UNKNOWN", "UNKNOWN", request_id)
            return JSONResponse(error.payload(), status_code=503, headers={"Cache-Control": "no-store"})

    return web

"""Dependency-free STT admission and private-journal protocol.

The deployment must have one writer, including during replacement: Modal's
max_containers=1 is not a distributed lease between different deployments.
Never remove an ENTERED/UNKNOWN row to make a request run again. Audio is not
stored; only its SHA256 fingerprint and the private completed transcript are.
"""

import hashlib
import hmac
import json
import math
import os
from contextlib import ExitStack
from pathlib import Path
import re
import stat
import threading
import uuid
from dataclasses import dataclass

MODEL_REPOSITORY = "Systran/faster-whisper-base"
MODEL_REVISION = "a80717a3a48b1b28aa687bca146cb7301feae1b1"
MAX_ENCODED_BYTES = 1024 * 1024
MAX_SECONDS = 30
SAMPLE_RATE = 16000
MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS
MAX_TRANSCRIPT_CHARS = 4096
MEDIA_TYPES = frozenset(("audio/webm", "audio/ogg", "audio/mp4", "audio/wav"))
ID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


class ProtocolError(Exception):
    def __init__(self, status, code, state="REJECTED", request_id=None):
        super().__init__(code)  # No native exception, audio, or transcript in errors.
        self.status, self.code, self.state, self.request_id = status, code, state, request_id

    def payload(self):
        return {"format": "o-private-stt-error", "version": 1, "requestId": self.request_id,
                "code": self.code, "state": self.state, "replayAllowed": False}


def authenticate(authorization, token):
    if not isinstance(token, str) or not 32 <= len(token) <= 256 or not token.isascii() or any(c.isspace() for c in token):
        raise ProtocolError(503, "AUTH_NOT_CONFIGURED", "UNKNOWN")
    if not isinstance(authorization, str) or len(authorization) > 264 or not authorization.isascii():
        raise ProtocolError(401, "AUTH_REQUIRED")
    if not hmac.compare_digest(authorization, "Bearer " + token):
        raise ProtocolError(401, "AUTH_REQUIRED")


def validate_request_id(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ProtocolError(400, "INVALID_REQUEST_ID")
    return value


def media_type(value):
    if not isinstance(value, str) or len(value) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ProtocolError(415, "UNSUPPORTED_MEDIA_TYPE")
    base = value.split(";", 1)[0].strip().lower()
    if base not in MEDIA_TYPES:
        raise ProtocolError(415, "UNSUPPORTED_MEDIA_TYPE")
    return base


def validate_body(body):
    if not isinstance(body, bytes) or not body:
        raise ProtocolError(400, "EMPTY_AUDIO")
    if len(body) > MAX_ENCODED_BYTES:
        raise ProtocolError(413, "AUDIO_TOO_LARGE")


@dataclass(frozen=True)
class DecodedAudio:
    samples: object
    sample_count: int
    sample_rate: int = SAMPLE_RATE


def validate_result(value, request_id):
    keys = {"format", "version", "requestId", "transcript", "languageDetected", "durationSeconds", "model", "replayAllowed"}
    if type(value) is not dict or set(value) != keys:
        raise ValueError("Invalid saved response")
    text, language, duration = value["transcript"], value["languageDetected"], value["durationSeconds"]
    if (value["format"] != "o-private-stt" or type(value["version"]) is not int or value["version"] != 1
            or value["requestId"] != request_id or value["replayAllowed"] is not False):
        raise ValueError("Invalid saved response")
    if not isinstance(text, str) or not text.strip() or len(text.encode("utf-16-le")) // 2 > MAX_TRANSCRIPT_CHARS:
        raise ValueError("Invalid transcript")
    if any((ord(c) < 32 and c not in "\n\t") or ord(c) == 127 for c in text):
        raise ValueError("Invalid transcript")
    if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language):
        raise ValueError("Invalid detected language")
    if type(duration) not in (int, float) or not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS:
        raise ValueError("Invalid duration")
    if value["model"] != {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "computeType": "int8"}:
        raise ValueError("Invalid model identity")
    return value


class FileJournal:
    """Single-writer private filesystem journal; commit must acknowledge storage.

    commit is injected as Modal Volume.commit. fsync alone does not establish
    remote Volume durability. Any commit uncertainty holds this process; durable
    ENTERED/UNKNOWN or malformed/partial rows hold subsequent cold starts.
    The bounded census deliberately refuses instead of dropping old identities.
    """
    MAX_ROWS = 10000
    MAX_ROW_BYTES = 32768

    def __init__(self, root, commit):
        self.root = Path(root)
        self.commit = commit
        self.held = False
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self.root.is_absolute() or self.root.is_symlink() or self.root.resolve() != self.root:
            raise ValueError("Private plain journal path required")

    @staticmethod
    def _identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)

    def _paths(self):
        paths = []
        for path in self.root.iterdir():
            if len(paths) >= self.MAX_ROWS:
                raise ValueError("Journal census bound")
            paths.append(path)
        return paths

    def _sync_directory(self):
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self.root, flags)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISDIR(before.st_mode) or self._identity(before) != self._identity(self.root.lstat()):
                raise ValueError("Journal directory identity changed")
            os.fsync(descriptor)
            if self._identity(before) != self._identity(os.fstat(descriptor)) or self._identity(before) != self._identity(self.root.lstat()):
                raise ValueError("Journal directory identity changed")
        finally:
            os.close(descriptor)  # Close must succeed before Volume commit.
        return self._identity(before)

    def _read_all(self, reconcile_completed=False):
        if self.held:
            raise ProtocolError(503, "STORAGE_HELD", "UNKNOWN")
        rows = {}
        paths = self._paths()
        retained = []
        with ExitStack() as handles:
            for path in paths:
                named = path.lstat()
                if not stat.S_ISREG(named.st_mode) or path.suffix != ".json":
                    raise ValueError("Unexpected journal member")
                request_id = validate_request_id(path.stem)
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    stream = os.fdopen(descriptor, "rb")
                except BaseException:
                    os.close(descriptor)
                    raise
                handles.enter_context(stream)
                observed = os.fstat(stream.fileno())
                identity = self._identity(observed)
                if not stat.S_ISREG(observed.st_mode) or identity != self._identity(named):
                    raise ValueError("Journal file identity changed")
                if observed.st_size > self.MAX_ROW_BYTES:
                    raise ValueError("Journal row bound")
                raw = stream.read(self.MAX_ROW_BYTES + 1)
                if len(raw) > self.MAX_ROW_BYTES or len(raw) != observed.st_size:
                    raise ValueError("Journal row bound or mutation")
                row = json.loads(raw.decode("utf-8"))
                if type(row) is not dict:
                    raise ValueError("Invalid journal row")
                common = {"format", "version", "requestId", "fingerprint", "state"}
                expected = common | ({"result"} if row.get("state") == "COMPLETED" else set())
                if (set(row) != expected or row.get("format") != "o-private-stt-journal"
                        or type(row.get("version")) is not int or row.get("version") != 1 or row.get("requestId") != request_id
                        or row.get("state") not in ("ENTERED", "COMPLETED", "UNKNOWN")
                        or not isinstance(row.get("fingerprint"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["fingerprint"])):
                    raise ValueError("Invalid journal row")
                if row["state"] == "COMPLETED":
                    validate_result(row["result"], request_id)
                if identity != self._identity(os.fstat(stream.fileno())) or identity != self._identity(path.lstat()):
                    raise ValueError("Journal file identity changed")
                rows[request_id] = row
                retained.append((path, stream, identity))

            if reconcile_completed:
                # A saved known completion may have outlived a failed terminal
                # persistence acknowledgment. Never treat visibility as durability.
                if any(row["state"] != "COMPLETED" for row in rows.values()):
                    raise ProtocolError(409, "PRIOR_REQUEST_UNKNOWN", "UNKNOWN")
                for path, stream, identity in retained:
                    if identity != self._identity(os.fstat(stream.fileno())) or identity != self._identity(path.lstat()):
                        raise ValueError("Journal file identity changed")
                    os.fsync(stream.fileno())
                    if identity != self._identity(os.fstat(stream.fileno())) or identity != self._identity(path.lstat()):
                        raise ValueError("Journal file identity changed")
                handles.close()  # Every retained file close must succeed.
                expected_names = sorted(path.name for path in paths)

                def verify_closed_census():
                    current = self._paths()
                    if sorted(path.name for path in current) != expected_names:
                        raise ValueError("Journal census changed")
                    for path, _, identity in retained:
                        if identity != self._identity(path.lstat()):
                            raise ValueError("Journal file identity changed")

                verify_closed_census()
                directory_identity = self._sync_directory()
                self.commit()  # No row rewrite, intent conversion, or inference.
                if directory_identity != self._identity(self.root.lstat()):
                    raise ValueError("Journal directory identity changed")
                verify_closed_census()
        return rows

    def _write(self, row, exclusive=False):
        path = self.root / (row["requestId"] + ".json")
        target = path if exclusive else self.root / (row["requestId"] + "." + uuid.uuid4().hex + ".tmp")
        raw = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > self.MAX_ROW_BYTES:
            raise ValueError("Journal row bound")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(target, flags, 0o600), "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if not exclusive:
            os.replace(target, path)
        directory = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        self.commit()  # Must complete before decoder/ASR or successful response.

    def claim(self, request_id, fingerprint):
        try:
            rows = self._read_all(reconcile_completed=True)
            row = rows.get(request_id)
            if row is not None:
                if row["fingerprint"] != fingerprint:
                    raise ProtocolError(409, "REQUEST_ID_CONFLICT", "UNKNOWN", request_id)
                if row["state"] == "COMPLETED":
                    return row["result"]
                raise ProtocolError(409, "REQUEST_UNKNOWN", "UNKNOWN", request_id)
            if any(row["state"] != "COMPLETED" for row in rows.values()):
                raise ProtocolError(409, "PRIOR_REQUEST_UNKNOWN", "UNKNOWN", request_id)
            if len(rows) >= self.MAX_ROWS:
                raise ProtocolError(503, "JOURNAL_FULL", "UNKNOWN", request_id)
            self._write({"format": "o-private-stt-journal", "version": 1, "requestId": request_id,
                         "fingerprint": fingerprint, "state": "ENTERED"}, exclusive=True)
            return None
        except ProtocolError as error:
            if error.request_id is None:
                error.request_id = request_id
            raise
        except Exception:
            self.held = True
            raise ProtocolError(503, "STORAGE_HELD", "UNKNOWN", request_id) from None

    def complete(self, request_id, result):
        row = self._read_all()[request_id]
        if row["state"] != "ENTERED":
            raise ValueError("Terminal request cannot run again")
        validate_result(result, request_id)
        self._write({**row, "state": "COMPLETED", "result": result})

    def unknown(self, request_id):
        try:
            row = self._read_all()[request_id]
            row.pop("result", None)
            self._write({**row, "state": "UNKNOWN"})
        except Exception:
            pass
        self.held = True  # Even an unconfirmed UNKNOWN commit holds this process.


class TranscriptionService:
    def __init__(self, journal, decode, infer):
        self.journal, self.decode, self.infer = journal, decode, infer
        self.lock = threading.Lock()
        self.held = False

    def process(self, request_id, content_type, body):
        validate_request_id(request_id)
        kind = media_type(content_type)
        validate_body(body)
        if self.held:
            raise ProtocolError(503, "STORAGE_HELD", "UNKNOWN", request_id)
        if not self.lock.acquire(blocking=False):
            raise ProtocolError(503, "REQUEST_BUSY", "UNKNOWN", request_id)
        try:
            fingerprint = hashlib.sha256(kind.encode("ascii") + b"\0" + body).hexdigest()
            prior = self.journal.claim(request_id, fingerprint)
            if prior is not None:
                return validate_result(prior, request_id)
            try:
                audio = self.decode(body, kind)
                if (not isinstance(audio, DecodedAudio) or type(audio.sample_count) is not int
                        or type(audio.sample_rate) is not int or audio.sample_rate != SAMPLE_RATE
                        or not 0 < audio.sample_count <= MAX_SAMPLES):
                    raise ValueError("Decoded audio bound")
                transcript, language = self.infer(audio.samples)
                result = validate_result({"format": "o-private-stt", "version": 1, "requestId": request_id,
                    "transcript": transcript, "languageDetected": language,
                    "durationSeconds": audio.sample_count / SAMPLE_RATE,
                    "model": {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "computeType": "int8"},
                    "replayAllowed": False}, request_id)
                self.journal.complete(request_id, result)
                return result
            except BaseException:
                self.held = True
                try:
                    self.journal.unknown(request_id)
                except BaseException:
                    pass  # Unconfirmed UNKNOWN persistence cannot reopen this lane.
                raise ProtocolError(503, "TRANSCRIPTION_UNKNOWN", "UNKNOWN", request_id) from None
        finally:
            self.lock.release()

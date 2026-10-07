"""Fictional bytes, fake decoder/model, and RAM journal only. No ASR imports."""
import copy
import hashlib
import io
import json
import stat
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import Mock, patch

import stt_protocol

from stt_protocol import (DecodedAudio, FileJournal, MAX_ENCODED_BYTES, MAX_SAMPLES,
    MODEL_REPOSITORY, MODEL_REVISION, ProtocolError, TranscriptionService,
    authenticate, media_type, validate_request_id, validate_result)

ID = "89e71d5a-b263-4ba8-9141-c6f99ee5e322"
OTHER_ID = "ceb78d4d-2d04-478f-a771-2e12db79618e"


def saved_result():
    return {"format": "o-private-stt", "version": 1, "requestId": ID,
            "transcript": "Hola, hello.", "languageDetected": "es", "durationSeconds": 1.0,
            "model": {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "computeType": "int8"},
            "replayAllowed": False}


class FakeDisk:
    """RAM path/descriptors/syscalls; never construct a real FileJournal path."""
    class Path:
        def __init__(self, disk, name, directory=False):
            self.disk, self.name, self.directory = disk, name, directory
            self.suffix = ".json" if name.endswith(".json") else ""
            self.stem = name[:-5] if self.suffix else name

        def lstat(self):
            return copy.copy(self.disk.named[self.name])

        def iterdir(self):
            return iter(list(self.disk.paths))

    class Stream(io.BytesIO):
        def __init__(self, disk, descriptor, raw):
            super().__init__(raw)
            self.disk, self.descriptor = disk, descriptor

        def fileno(self):
            return self.descriptor

        def close(self):
            if self.closed:
                return
            super().close()
            self.disk.events.append("file-close")
            if self.disk.fail_close:
                raise OSError("private-close-error")

    def __init__(self):
        self.events = []
        self.fail_commit = self.fail_close = self.fail_sync = False
        self.replace_at_sync = self.change_after_commit = False
        self.rows = {ID: {"format": "o-private-stt-journal", "version": 1,
            "requestId": ID, "fingerprint": "a" * 64, "state": "COMPLETED", "result": saved_result()}}
        self.named, self.descriptors, self.raw, self.paths = {}, {}, {}, []
        self.root = self.Path(self, "requests", True)
        self.named["requests"] = self.info(10, stat.S_IFDIR | 0o700, 4096)
        self.descriptors[100] = copy.copy(self.named["requests"])
        self.rebuild()
        self.journal = FileJournal.__new__(FileJournal)
        self.journal.root, self.journal.commit, self.journal.held = self.root, self.commit, False
        self.journal._write = Mock(side_effect=lambda *_args, **_kwargs: self.events.append("new-intent-write"))

    @staticmethod
    def info(inode, mode, size):
        return SimpleNamespace(st_dev=1, st_ino=inode, st_mode=mode, st_size=size, st_mtime_ns=4, st_ctime_ns=5)

    def rebuild(self):
        self.paths = []
        for index, (request_id, row) in enumerate(self.rows.items(), 1):
            name = request_id + ".json"
            raw = json.dumps(row).encode("utf-8")
            self.raw[index] = raw
            self.named[name] = self.info(1000 + index, stat.S_IFREG | 0o600, len(raw))
            self.descriptors[index] = copy.copy(self.named[name])
            self.paths.append(self.Path(self, name))

    def open(self, path, _flags, *_args):
        if path is self.root:
            return 100
        return self.paths.index(path) + 1

    def fsync(self, descriptor):
        self.events.append("dir-sync" if descriptor == 100 else "file-sync")
        if self.fail_sync and descriptor != 100:
            raise OSError("private-sync-error")
        if self.replace_at_sync and descriptor != 100:
            self.named[self.paths[descriptor - 1].name].st_ino += 99

    def close(self, descriptor):
        self.events.append("dir-close" if descriptor == 100 else "file-close")

    def commit(self):
        self.events.append("volume-commit-entered")
        if self.fail_commit:
            raise OSError("private-volume-ack-error")
        self.events.append("volume-commit-ack")
        if self.change_after_commit:
            self.paths.append(self.Path(self, "unexpected.tmp"))

    def patched(self):
        stack = ExitStack()
        stack.enter_context(patch.object(stt_protocol.os, "open", self.open))
        stack.enter_context(patch.object(stt_protocol.os, "fdopen", lambda fd, _mode: self.Stream(self, fd, self.raw[fd])))
        stack.enter_context(patch.object(stt_protocol.os, "fstat", lambda fd: copy.copy(self.descriptors[fd])))
        stack.enter_context(patch.object(stt_protocol.os, "fsync", self.fsync))
        stack.enter_context(patch.object(stt_protocol.os, "close", self.close))
        return stack


class CompletedReconciliationTests(unittest.TestCase):
    def test_known_completed_cached_result_requires_read_fsync_close_and_volume_ack(self):
        disk = FakeDisk()
        with disk.patched():
            service = TranscriptionService(disk.journal, Mock(side_effect=AssertionError("decoder replay")), Mock(side_effect=AssertionError("ASR replay")))
            fingerprint = hashlib.sha256(b"audio/wav\0fictional").hexdigest()
            disk.rows[ID]["fingerprint"] = fingerprint
            disk.rebuild()
            self.assertEqual(service.process(ID, "audio/wav", b"fictional"), saved_result())
        self.assertEqual(disk.events, ["file-sync", "file-close", "dir-sync", "dir-close", "volume-commit-entered", "volume-commit-ack"])
        disk.journal._write.assert_not_called()
        service.decode.assert_not_called()
        service.infer.assert_not_called()

    def test_fresh_intent_follows_all_saved_completion_recommit_ack(self):
        disk = FakeDisk()
        with disk.patched():
            self.assertIsNone(disk.journal.claim(OTHER_ID, "b" * 64))
        self.assertEqual(disk.events[-2:], ["volume-commit-ack", "new-intent-write"])
        self.assertEqual(disk.rows[ID]["state"], "COMPLETED")
        self.assertEqual(disk.journal._write.call_args.args[0]["requestId"], OTHER_ID)

    def test_saved_completion_recommit_failure_blocks_cached_and_fresh_admission(self):
        for request_id in (ID, OTHER_ID):
            with self.subTest(request_id=request_id):
                disk = FakeDisk()
                disk.fail_commit = True
                with disk.patched(), self.assertRaises(ProtocolError) as caught:
                    disk.journal.claim(request_id, "a" * 64)
                self.assertEqual((caught.exception.status, caught.exception.state, caught.exception.code), (503, "UNKNOWN", "STORAGE_HELD"))
                self.assertTrue(disk.journal.held)
                disk.journal._write.assert_not_called()
                self.assertEqual(disk.rows[ID]["state"], "COMPLETED")
                self.assertNotIn("private-volume-ack-error", str(caught.exception.payload()))

    def test_replaced_named_file_after_fsync_holds_without_volume_ack_or_row_rewrite(self):
        disk = FakeDisk()
        disk.replace_at_sync = True
        with disk.patched(), self.assertRaises(ProtocolError) as caught:
            disk.journal.claim(OTHER_ID, "b" * 64)
        self.assertEqual(caught.exception.state, "UNKNOWN")
        self.assertNotIn("volume-commit-entered", disk.events)
        disk.journal._write.assert_not_called()

    def test_read_descriptor_close_failure_blocks_commit_and_fresh_intent(self):
        disk = FakeDisk()
        disk.fail_close = True
        with disk.patched(), self.assertRaises(ProtocolError):
            disk.journal.claim(OTHER_ID, "b" * 64)
        self.assertNotIn("volume-commit-entered", disk.events)
        disk.journal._write.assert_not_called()

    def test_file_fsync_failure_holds_without_commit(self):
        disk = FakeDisk()
        disk.fail_sync = True
        with disk.patched(), self.assertRaises(ProtocolError):
            disk.journal.claim(OTHER_ID, "b" * 64)
        self.assertNotIn("volume-commit-entered", disk.events)
        disk.journal._write.assert_not_called()

    def test_census_change_after_commit_ack_still_holds_fresh_admission(self):
        disk = FakeDisk()
        disk.change_after_commit = True
        with disk.patched(), self.assertRaises(ProtocolError):
            disk.journal.claim(OTHER_ID, "b" * 64)
        self.assertIn("volume-commit-ack", disk.events)
        disk.journal._write.assert_not_called()

    def test_entered_or_unknown_census_is_not_reconciled_into_completion(self):
        for state in ("ENTERED", "UNKNOWN"):
            with self.subTest(state=state):
                disk = FakeDisk()
                disk.rows[OTHER_ID] = {"format": "o-private-stt-journal", "version": 1,
                    "requestId": OTHER_ID, "fingerprint": "b" * 64, "state": state}
                disk.rebuild()
                with disk.patched(), self.assertRaises(ProtocolError) as caught:
                    disk.journal.claim(ID, "a" * 64)
                self.assertEqual((caught.exception.status, caught.exception.state), (409, "UNKNOWN"))
                self.assertNotIn("file-sync", disk.events)
                self.assertNotIn("volume-commit-entered", disk.events)
                disk.journal._write.assert_not_called()
                self.assertEqual(disk.rows[OTHER_ID]["state"], state)

    def test_corrupt_saved_response_never_recommit_qualifies(self):
        disk = FakeDisk()
        disk.rows[ID]["result"]["model"]["revision"] = "main"
        disk.rebuild()
        with disk.patched(), self.assertRaises(ProtocolError):
            disk.journal.claim(OTHER_ID, "b" * 64)
        self.assertNotIn("volume-commit-entered", disk.events)
        disk.journal._write.assert_not_called()


class FakeJournal:
    def __init__(self):
        self.rows = {}
        self.events = []
        self.fail_claim = False
        self.fail_complete = False
        self.fail_unknown = False
        self.held = False

    def claim(self, request_id, fingerprint):
        if self.held or self.fail_claim:
            raise ProtocolError(503, "STORAGE_HELD", "UNKNOWN", request_id)
        existing = self.rows.get(request_id)
        if existing:
            if existing["fingerprint"] != fingerprint:
                raise ProtocolError(409, "REQUEST_ID_CONFLICT", "UNKNOWN", request_id)
            if existing["state"] == "COMPLETED":
                return copy.deepcopy(existing["result"])
            raise ProtocolError(409, "REQUEST_UNKNOWN", "UNKNOWN", request_id)
        if any(row["state"] != "COMPLETED" for row in self.rows.values()):
            raise ProtocolError(409, "PRIOR_REQUEST_UNKNOWN", "UNKNOWN", request_id)
        self.rows[request_id] = {"state": "ENTERED", "fingerprint": fingerprint}
        self.events.append("intent-commit-ack")

    def complete(self, request_id, result):
        if self.fail_complete:
            raise OSError("private-native-error-must-not-escape")
        self.rows[request_id].update(state="COMPLETED", result=copy.deepcopy(result))
        self.events.append("terminal-commit-ack")

    def unknown(self, request_id):
        self.held = True
        if self.fail_unknown:
            raise OSError("unknown-commit-private-detail")
        self.rows[request_id].update(state="UNKNOWN")
        self.rows[request_id].pop("result", None)
        self.events.append("unknown")


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.journal = FakeJournal()
        self.decoded = DecodedAudio(object(), 16000)
        self.calls = []
        self.answer = ("Hola, hello.", "es")
        self.decode_error = None
        self.infer_error = None

        def decode(body, kind):
            self.assertEqual(self.journal.rows[ID]["state"], "ENTERED")
            self.assertEqual(self.journal.events[0], "intent-commit-ack")
            self.calls.append(("decode", kind))
            if self.decode_error:
                raise self.decode_error
            return self.decoded

        def infer(samples):
            self.assertIs(samples, self.decoded.samples)
            self.calls.append(("infer",))
            if self.infer_error:
                raise self.infer_error
            return self.answer

        self.service = TranscriptionService(self.journal, decode, infer)

    def run_request(self, request_id=ID, kind="audio/wav", body=b"fictional-audio-not-decoded"):
        return self.service.process(request_id, kind, body)

    def assert_error(self, status, state, function):
        with self.assertRaises(ProtocolError) as caught:
            function()
        self.assertEqual((caught.exception.status, caught.exception.state), (status, state))
        return caught.exception

    def test_authenticated_bearer_is_exact_and_missing_secret_refuses(self):
        token = "x" * 40
        authenticate("Bearer " + token, token)
        for authorization in (None, "bearer " + token, "Bearer " + token + " ", "Bearer wrong", "Bearer \u00e9"):
            with self.subTest(authorization=authorization):
                self.assert_error(401, "REJECTED", lambda: authenticate(authorization, token))
        self.assert_error(503, "UNKNOWN", lambda: authenticate(None, None))

    def test_only_canonical_uuid_v4_is_accepted(self):
        self.assertEqual(validate_request_id(ID), ID)
        for invalid in (ID.upper(), ID.replace("4ba8", "3ba8"), "../" + ID, "", None, ID + "\n"):
            with self.subTest(value=invalid):
                self.assert_error(400, "REJECTED", lambda: validate_request_id(invalid))

    def test_explicit_media_types_and_browser_codec_parameter(self):
        for kind in ("audio/wav", "audio/webm", "audio/ogg", "audio/mp4"):
            self.assertEqual(media_type(kind), kind)
        self.assertEqual(media_type('audio/webm;codecs=opus'), "audio/webm")
        for kind in ("video/mp4", "application/octet-stream", "audio/mpeg", "audio/wav\r\nsecret", None):
            self.assert_error(415, "REJECTED", lambda: media_type(kind))

    def test_invalid_admission_has_no_journal_decoder_or_inference_effect(self):
        cases = [(400, lambda: self.run_request(request_id="bad")),
                 (415, lambda: self.run_request(kind="video/mp4")),
                 (400, lambda: self.run_request(body=b"")),
                 (413, lambda: self.run_request(body=b"x" * (MAX_ENCODED_BYTES + 1)))]
        for status, action in cases:
            self.assert_error(status, "REJECTED", action)
        self.assertEqual((self.calls, self.journal.rows), ([], {}))

    def test_entered_is_durable_before_decode_and_terminal_before_reply(self):
        result = self.run_request()
        self.assertEqual(self.journal.events, ["intent-commit-ack", "terminal-commit-ack"])
        self.assertEqual(self.calls, [("decode", "audio/wav"), ("infer",)])
        self.assertEqual(result, {"format": "o-private-stt", "version": 1, "requestId": ID,
            "transcript": "Hola, hello.", "languageDetected": "es", "durationSeconds": 1.0,
            "model": {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "computeType": "int8"},
            "replayAllowed": False})

    def test_duplicate_completed_id_returns_cached_without_decode_or_asr(self):
        original = self.run_request()
        first_calls = list(self.calls)
        cold_service = TranscriptionService(self.journal, lambda *_: self.fail("decoder replay"), lambda *_: self.fail("ASR replay"))
        self.assertEqual(cold_service.process(ID, "audio/wav", b"fictional-audio-not-decoded"), original)
        self.assertEqual(self.calls, first_calls)

    def test_same_id_changed_bytes_or_media_is_unknown_conflict_without_replay(self):
        self.run_request()
        for kind, body in (("audio/wav", b"different"), ("audio/ogg", b"fictional-audio-not-decoded")):
            error = self.assert_error(409, "UNKNOWN", lambda: self.run_request(kind=kind, body=body))
            self.assertEqual(error.code, "REQUEST_ID_CONFLICT")
        self.assertEqual(len(self.calls), 2)

    def test_crashed_entered_survives_cold_service_and_blocks_other_ids(self):
        fingerprint = hashlib.sha256(b"audio/wav\0fictional-audio-not-decoded").hexdigest()
        self.journal.rows[ID] = {"state": "ENTERED", "fingerprint": fingerprint}
        for request_id in (ID, OTHER_ID):
            self.assert_error(409, "UNKNOWN", lambda: self.run_request(request_id=request_id))
        self.assertEqual(self.calls, [])

    def test_intent_commit_failure_never_calls_decoder_or_model(self):
        self.journal.fail_claim = True
        self.assert_error(503, "UNKNOWN", self.run_request)
        self.assertEqual(self.calls, [])

    def test_decoder_failure_after_entry_is_unknown_and_has_no_asr(self):
        self.decode_error = ValueError("private-audio-details")
        error = self.assert_error(503, "UNKNOWN", self.run_request)
        self.assertEqual(error.code, "TRANSCRIPTION_UNKNOWN")
        self.assertEqual(self.calls, [("decode", "audio/wav")])
        self.assertEqual(self.journal.rows[ID]["state"], "UNKNOWN")
        self.assertNotIn("private-audio-details", str(error.payload()))

    def test_decoded_duration_checked_before_asr(self):
        for count in (0, -1, MAX_SAMPLES + 1, 16000.0, True):
            with self.subTest(count=count):
                self.setUp()
                self.decoded = DecodedAudio(object(), count)
                self.assert_error(503, "UNKNOWN", self.run_request)
                self.assertEqual(self.calls, [("decode", "audio/wav")])

    def test_exact_max_duration_and_encoded_size_are_allowed(self):
        self.decoded = DecodedAudio(object(), MAX_SAMPLES)
        self.assertEqual(self.run_request(body=b"x" * MAX_ENCODED_BYTES)["durationSeconds"], 30)

    def test_unexpected_sample_rate_is_unknown_before_asr(self):
        self.decoded = DecodedAudio(object(), 16000, 48000)
        self.assert_error(503, "UNKNOWN", self.run_request)
        self.assertEqual(self.calls, [("decode", "audio/wav")])

    def test_model_exception_and_cancellation_hold_without_retry(self):
        for failure in (RuntimeError("private-model-detail"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                self.setUp()
                self.infer_error = failure
                error = self.assert_error(503, "UNKNOWN", self.run_request)
                self.assertNotIn("private-model-detail", str(error.payload()))
                self.assert_error(503, "UNKNOWN", self.run_request)
                self.assertEqual(len(self.calls), 2)

    def test_terminal_commit_failure_does_not_return_completed(self):
        self.journal.fail_complete = True
        self.assert_error(503, "UNKNOWN", self.run_request)
        self.assertEqual(self.journal.rows[ID]["state"], "UNKNOWN")
        self.assertNotIn("result", self.journal.rows[ID])

    def test_unknown_persistence_failure_still_holds_lane_and_hides_error(self):
        self.infer_error = RuntimeError("private-inference-detail")
        self.journal.fail_unknown = True
        error = self.assert_error(503, "UNKNOWN", self.run_request)
        self.assertEqual(error.code, "TRANSCRIPTION_UNKNOWN")
        self.assertNotIn("unknown-commit-private-detail", str(error.payload()))
        self.assert_error(503, "UNKNOWN", lambda: self.run_request(request_id=OTHER_ID))
        self.assertEqual(len(self.calls), 2)

    def test_transcript_limit_counts_browser_utf16_and_never_truncates(self):
        self.answer = ("a" * 4096, "en")
        self.assertEqual(len(self.run_request()["transcript"]), 4096)
        for text in ("a" * 4097, "\U0001f600" * 2049, "", "  ", "hello\0secret", "\ud800"):
            with self.subTest(length=len(text)):
                self.setUp()
                self.answer = (text, "en")
                self.assert_error(503, "UNKNOWN", self.run_request)

    def test_detected_language_is_bounded_not_fabricated(self):
        for language in ("EN", "english", "es<script>", None):
            with self.subTest(language=language):
                self.setUp()
                self.answer = ("hello", language)
                self.assert_error(503, "UNKNOWN", self.run_request)

    def test_saved_envelope_rejects_wrong_pin_extra_raw_field_and_nonfinite_duration(self):
        result = self.run_request()
        variants = [dict(result, rawAudio="secret"), dict(result, durationSeconds=float("nan")),
                    dict(result, durationSeconds=True), dict(result, replayAllowed=True)]
        wrong_pin = copy.deepcopy(result)
        wrong_pin["model"]["revision"] = "main"
        variants.append(wrong_pin)
        for value in variants:
            with self.assertRaises(ValueError):
                validate_result(value, ID)

    def test_busy_request_refuses_before_entry(self):
        self.service.lock.acquire()
        try:
            self.assert_error(503, "UNKNOWN", self.run_request)
        finally:
            self.service.lock.release()
        self.assertEqual((self.calls, self.journal.rows), ([], {}))

    def test_error_envelope_is_closed_generic_and_null_when_id_invalid(self):
        error = ProtocolError(400, "INVALID_REQUEST_ID")
        self.assertEqual(error.payload(), {"format": "o-private-stt-error", "version": 1,
            "requestId": None, "code": "INVALID_REQUEST_ID", "state": "REJECTED", "replayAllowed": False})
        self.assertEqual(ProtocolError(503, "TRANSCRIPTION_UNKNOWN", "UNKNOWN", ID).payload()["requestId"], ID)


if __name__ == "__main__":
    unittest.main()

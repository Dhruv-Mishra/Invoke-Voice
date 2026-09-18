import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("voice_pack", Path(__file__).resolve().parents[1] / "scripts" / "voice_pack.py")
voice_pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice_pack)


class VoicePackTest(unittest.TestCase):
    def test_repack_preserves_every_byte_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "wheelhouse").mkdir(parents=True)
            wheel = source / "wheelhouse" / "fixture-1-py3-none-any.whl"
            contents = {"fixture/code.py": b"hello" * 1000, "fixture-1.dist-info/RECORD": b"record", "fixture/lib.lib": bytes(range(256)) * 100}
            with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name, data in contents.items():
                    output.writestr(name, data)
            original_hash = voice_pack.digest(wheel)
            (source / "manifest.json").write_text(json.dumps({"wheels": [{"name": "fixture", "version": "1", "filename": wheel.name, "sha256": original_hash}]}))
            target = root / "target"
            voice_pack.prepare(source, target)
            with zipfile.ZipFile(target / "wheelhouse" / wheel.name) as result:
                self.assertEqual(result.namelist(), list(contents))
                for name, data in contents.items():
                    self.assertEqual(result.read(name), data)
                    self.assertEqual(result.getinfo(name).compress_type, zipfile.ZIP_STORED)
            manifest = json.loads((target / "manifest.json").read_text())
            self.assertEqual(manifest["wheels"][0]["sourceSha256"], original_hash)
            self.assertEqual(voice_pack.digest(wheel), original_hash)
            packed = root / "pack.tar.xz"
            voice_pack.archive(target, packed)
            unpacked = root / "unpacked"
            voice_pack.extract(packed, unpacked, 1024 * 1024)
            for filename in target.rglob("*"):
                if filename.is_file():
                    self.assertEqual(voice_pack.digest(filename), voice_pack.digest(unpacked / filename.relative_to(target)))

    def test_rejects_unsafe_entries_and_expansion(self):
        for name, kind, limit in [("../escape", tarfile.REGTYPE, 100), ("wheelhouse/link.whl", tarfile.SYMTYPE, 100), ("wheelhouse/test.whl", tarfile.REGTYPE, 1), ("wheelhouse/../bad.whl", tarfile.REGTYPE, 100), ("wheelhouse/./bad.whl", tarfile.REGTYPE, 100), ("wheelhouse/CON.whl", tarfile.REGTYPE, 100)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                packed = root / "bad.tar.xz"
                with tarfile.open(packed, "w:xz") as output:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.size = 4 if kind == tarfile.REGTYPE else 0
                    entry.linkname = "../escape" if kind == tarfile.SYMTYPE else ""
                    output.addfile(entry, io.BytesIO(b"test") if entry.size else None)
                with self.assertRaises(ValueError):
                    voice_pack.extract(packed, root / "unpacked", limit)


if __name__ == "__main__":
    unittest.main()
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import zipfile


def digest(filename):
    with open(filename, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(source, destination):
    source, destination = Path(source), Path(destination)
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    (destination / "wheelhouse").mkdir(parents=True)
    for wheel in manifest["wheels"]:
        original = source / "wheelhouse" / wheel["filename"]
        target = destination / "wheelhouse" / wheel["filename"]
        if digest(original) != wheel["sha256"]:
            raise ValueError("Source wheel checksum mismatch")
        with zipfile.ZipFile(original) as incoming, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as outgoing:
            if len(set(incoming.namelist())) != len(incoming.namelist()):
                raise ValueError("Duplicate wheel entry")
            for entry in incoming.infolist():
                stored = copy.copy(entry)
                stored.compress_type = zipfile.ZIP_STORED
                with incoming.open(entry) as reader, outgoing.open(stored, "w", force_zip64=True) as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
        with zipfile.ZipFile(original) as incoming, zipfile.ZipFile(target) as outgoing:
            if incoming.namelist() != outgoing.namelist():
                raise ValueError("Wheel entries changed")
            for name in incoming.namelist():
                with incoming.open(name) as before, outgoing.open(name) as after:
                    if hashlib.file_digest(before, "sha256").digest() != hashlib.file_digest(after, "sha256").digest():
                        raise ValueError("Wheel contents changed")
        wheel["sourceSha256"] = wheel["sha256"]
        wheel["sha256"] = digest(target)
        wheel["size"] = target.stat().st_size
    lock = "".join(f'{wheel["name"]}=={wheel["version"]} --hash=sha256:{wheel["sha256"]}\n' for wheel in manifest["wheels"])
    lock_file = destination / "requirements.lock"
    lock_file.write_bytes(lock.encode("utf-8"))
    manifest["lock"] = {"filename": "requirements.lock", "size": lock_file.stat().st_size, "sha256": digest(lock_file)}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def archive(source, destination):
    source = Path(source)
    with tarfile.open(destination, "w:xz", preset=9) as output:
        for filename in sorted(source.rglob("*")):
            if filename.is_file():
                info = output.gettarinfo(filename, arcname=filename.relative_to(source).as_posix())
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with filename.open("rb") as stream:
                    output.addfile(info, stream)


def extract(source, destination, limit):
    seen = set()
    expanded = 0
    with tarfile.open(source, "r|xz") as incoming:
        for member in incoming:
            name = PurePosixPath(member.name)
            valid_name = member.name in ("manifest.json", "requirements.lock") or (
                len(name.parts) == 2 and name.parts[0] == "wheelhouse" and name.suffix == ".whl"
                and name.as_posix() == member.name
                and not re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.", name.name, re.IGNORECASE)
                and all(character.isascii() and (character.isalnum() or character in "._+-") for character in name.name)
            )
            if not member.isfile() or not valid_name or member.name in seen or len(seen) >= 512:
                raise ValueError("Invalid voice pack entry")
            seen.add(member.name)
            expanded += member.size
            if member.size < 0 or expanded > limit:
                raise ValueError("Voice pack exceeds expanded size limit")
            incoming.extract(member, destination, filter="data")
    if not {"manifest.json", "requirements.lock"}.issubset(seen):
        raise ValueError("Incomplete voice pack")


if __name__ == "__main__":
    operation, source, destination, *arguments = sys.argv[1:]
    if operation == "prepare":
        prepare(source, destination)
    elif operation == "archive":
        archive(source, destination)
    elif operation == "extract":
        extract(source, destination, int(arguments[0]))
    else:
        raise ValueError("Unknown voice pack operation")
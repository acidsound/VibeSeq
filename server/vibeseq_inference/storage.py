from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_UPLOAD_SUFFIXES = {
    ".wav",
    ".flac",
    ".mp3",
    ".ogg",
    ".m4a",
    ".aac",
    ".aif",
    ".aiff",
}


@dataclass(frozen=True, slots=True)
class Asset:
    id: str
    path: Path
    media_type: str
    download_name: str


class Storage:
    def __init__(self, root: Path) -> None:
        self.root = root.expanduser()
        self.assets_dir = self.root / "assets"
        self.jobs_dir = self.root / "jobs"
        self.uploads_dir = self.root / "uploads"
        for directory in (self.assets_dir, self.jobs_dir, self.uploads_dir):
            directory.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _id() -> str:
        return uuid.uuid4().hex

    @staticmethod
    def _valid_id(value: str) -> bool:
        return bool(_ID_PATTERN.fullmatch(value))

    @staticmethod
    def _write_json(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)

    def allocate_asset(self, suffix: str) -> tuple[str, Path]:
        if suffix not in {".wav", ".mid"}:
            raise ValueError("Unsupported generated asset suffix.")
        asset_id = self._id()
        return asset_id, self.assets_dir / f"{asset_id}{suffix}"

    def commit_asset(
        self,
        asset_id: str,
        path: Path,
        media_type: str,
        download_name: str,
    ) -> Asset:
        if not self._valid_id(asset_id) or path.parent != self.assets_dir:
            raise ValueError("Invalid asset allocation.")
        if not path.is_file():
            raise FileNotFoundError("Provider did not produce its output asset.")
        metadata = {
            "id": asset_id,
            "filename": path.name,
            "mediaType": media_type,
            "downloadName": Path(download_name).name,
        }
        self._write_json(self.assets_dir / f"{asset_id}.json", metadata)
        return Asset(asset_id, path, media_type, metadata["downloadName"])

    def discard_asset(self, asset_id: str, path: Path) -> None:
        path.unlink(missing_ok=True)
        if self._valid_id(asset_id):
            (self.assets_dir / f"{asset_id}.json").unlink(missing_ok=True)

    def get_asset(self, asset_id: str) -> Asset | None:
        if not self._valid_id(asset_id):
            return None
        metadata_path = self.assets_dir / f"{asset_id}.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            filename = Path(metadata["filename"]).name
            path = self.assets_dir / filename
            if not path.is_file() or not filename.startswith(asset_id):
                return None
            return Asset(
                id=asset_id,
                path=path,
                media_type=str(metadata["mediaType"]),
                download_name=Path(metadata["downloadName"]).name,
            )
        except (
            FileNotFoundError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ):
            return None

    def allocate_upload(self, filename: str | None) -> Path:
        suffix = Path(filename or "").suffix.lower()
        if suffix not in _UPLOAD_SUFFIXES:
            suffix = ".bin"
        return self.uploads_dir / f"{self._id()}{suffix}"

    def save_upload(self, filename: str | None, content: bytes) -> Path:
        path = self.allocate_upload(filename)
        path.write_bytes(content)
        return path

    def remove_upload(self, path: Path) -> None:
        if path.parent == self.uploads_dir:
            path.unlink(missing_ok=True)

    def job_path(self, job_id: str) -> Path:
        if not self._valid_id(job_id):
            raise ValueError("Invalid job id.")
        return self.jobs_dir / f"{job_id}.json"

    def save_job(self, job_id: str, value: dict[str, Any]) -> None:
        self._write_json(self.job_path(job_id), value)

    def load_jobs(self) -> list[dict[str, Any]]:
        jobs: list[dict[str, Any]] = []
        for path in self.jobs_dir.glob("*.json"):
            if not self._valid_id(path.stem):
                continue
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                jobs.append(value)
        return jobs

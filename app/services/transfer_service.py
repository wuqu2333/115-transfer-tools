from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import json
import os
import queue
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

from sqlalchemy.orm import Session, sessionmaker

from ..models import AppSettings, TransferTask
from .mobile_cloud_client import MobileCloudClient
from .openlist_client import OpenListClient, OpenListError, join_remote_path, normalize_remote_path

MAX_DOWNLOAD_CONCURRENCY = 3


@dataclass
class FileItem:
    remote_path: str
    relative_path: str


def get_or_create_settings(db: Session) -> AppSettings:
    settings = db.get(AppSettings, 1)
    if settings is None:
        settings = AppSettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)

    # Compatibility: migrate old default "downloads" to empty string.
    if settings.download_base_path == "downloads":
        created = settings.created_at
        updated = settings.updated_at
        if created and updated and abs((updated - created).total_seconds()) < 5:
            settings.download_base_path = ""
            db.commit()
            db.refresh(settings)
    return settings


class TransferWorker:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._queue: queue.Queue[int] = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True, name="transfer-worker")
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._thread.start()
        self._started = True

    def enqueue(self, task_id: int) -> None:
        self._queue.put(task_id)

    def _run(self) -> None:
        while True:
            task_id = self._queue.get()
            try:
                self._execute_task(task_id)
            except Exception as exc:  # noqa: BLE001
                self._mark_failed(task_id, f"Worker crashed: {exc}")
            finally:
                self._queue.task_done()

    def _mark_failed(self, task_id: int, error_message: str) -> None:
        with self._session_factory() as db:
            task = db.get(TransferTask, task_id)
            if task is None:
                return
            task.status = "failed"
            task.error_message = error_message
            task.finished_at = datetime.utcnow()
            task.updated_at = datetime.utcnow()
            self._append_log(task, f"Failed: {error_message}")
            db.commit()

    @staticmethod
    def _append_log(task: TransferTask, message: str) -> None:
        logs = json.loads(task.logs_json or "[]")
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        logs.append(f"[{ts}] {message}")
        if len(logs) > 400:
            logs = logs[-400:]
        task.logs_json = json.dumps(logs, ensure_ascii=False)
        task.message = message
        task.updated_at = datetime.utcnow()

    def _log(self, db: Session, task: TransferTask, message: str) -> None:
        self._append_log(task, message)
        db.commit()
        db.refresh(task)

    def _execute_task(self, task_id: int) -> None:
        with self._session_factory() as db:
            task = db.get(TransferTask, task_id)
            if task is None:
                return
            if task.status == "running":
                return

            settings = get_or_create_settings(db)
            task.status = "running"
            task.started_at = datetime.utcnow()
            task.finished_at = None
            task.error_message = ""
            task.processed_files = 0
            task.processed_bytes = 0
            task.total_files = 0
            task.total_bytes = 0
            task.current_item = ""
            task.logs_json = "[]"
            self._append_log(task, "Task started")
            db.commit()
            db.refresh(task)

            try:
                self._run_transfer(db=db, task=task, settings=settings)
                task.status = "success"
                task.finished_at = datetime.utcnow()
                self._append_log(task, "Task completed")
                db.commit()
            except Exception as exc:  # noqa: BLE001
                task.status = "failed"
                task.error_message = str(exc)
                task.finished_at = datetime.utcnow()
                self._append_log(task, f"Task failed: {exc}")
                db.commit()
                raise

    def _run_transfer(self, db: Session, task: TransferTask, settings: AppSettings) -> None:
        openlist = OpenListClient(
            base_url=settings.openlist_base_url,
            token=settings.openlist_token,
            password=settings.openlist_password,
        )

        mobile_client: MobileCloudClient | None = None
        if task.provider == "mobile":
            mobile_client = MobileCloudClient(
                authorization=settings.mobile_authorization,
                uni=settings.mobile_uni,
                parent_file_id=settings.mobile_parent_file_id,
                cloud_host=settings.mobile_cloud_host,
                app_channel=settings.mobile_app_channel,
                client_info=settings.mobile_client_info,
            )

        source_paths: list[str] = json.loads(task.source_paths_json or "[]")
        if not source_paths:
            raise RuntimeError("source_paths cannot be empty")

        all_files: list[FileItem] = []
        for src in source_paths:
            self._log(db, task, f"Resolving source: {src}")
            try:
                all_files.extend(self._expand_source(openlist, src))
            except OpenListError as exc:
                raise RuntimeError(f"source path unavailable: {src}, error={exc}") from exc

        if not all_files:
            raise RuntimeError("no file to process")

        task.total_files = len(all_files)
        db.commit()
        db.refresh(task)
        self._log(db, task, f"Collected files: {len(all_files)}")

        local_root = Path(task.local_download_path).resolve()
        local_root.mkdir(parents=True, exist_ok=True)
        self._log(
            db,
            task,
            f"Download policy: concurrency capped at {MAX_DOWNLOAD_CONCURRENCY}, start interval 2s, auto retry on 115 403",
        )
        mobile_dir_cache: dict[str, str] = {}
        if task.provider == "mobile":
            mobile_dir_cache[""] = settings.mobile_parent_file_id

        pending: dict = {}
        files_iter = iter(enumerate(all_files, start=1))
        processed_count = 0

        with ThreadPoolExecutor(
            max_workers=MAX_DOWNLOAD_CONCURRENCY, thread_name_prefix="dl-worker"
        ) as executor:

            def submit_next() -> bool:
                try:
                    index, file_item = next(files_iter)
                except StopIteration:
                    return False
                future = executor.submit(self._download_to_local, settings, file_item, local_root)
                pending[future] = (index, file_item)
                return True

            for _ in range(min(MAX_DOWNLOAD_CONCURRENCY, len(all_files))):
                submit_next()

            while pending:
                done, _ = wait(set(pending.keys()), return_when=FIRST_COMPLETED)
                for finished in done:
                    index, item = pending.pop(finished)
                    task.current_item = item.remote_path
                    db.commit()

                    try:
                        local_file, downloaded_size = finished.result()
                    except Exception as exc:  # noqa: BLE001
                        for f in pending:
                            f.cancel()
                        raise RuntimeError(
                            f"download failed: {item.remote_path}, error={exc}"
                        ) from exc

                    task.total_bytes += downloaded_size
                    db.commit()

                    if task.provider == "sharepoint":
                        remote_target = join_remote_path(task.target_path, item.relative_path)
                        self._log(
                            db,
                            task,
                            f"[{index}/{len(all_files)}] upload to sharepoint: {remote_target}",
                        )
                        openlist.upload_file(str(local_file), remote_target)
                    elif task.provider == "mobile":
                        if mobile_client is None:
                            raise RuntimeError("mobile client not initialized")
                        self._upload_to_mobile(
                            db=db,
                            task=task,
                            settings=settings,
                            openlist=openlist,
                            mobile_client=mobile_client,
                            local_file=local_file,
                            file_item=item,
                            mobile_dir_cache=mobile_dir_cache,
                        )
                    else:
                        raise RuntimeError(f"unsupported provider: {task.provider}")

                    processed_count += 1
                    task.processed_files = processed_count
                    task.processed_bytes += downloaded_size
                    db.commit()

                    if settings.clean_local_after_transfer and local_file.exists():
                        local_file.unlink(missing_ok=True)

                    submit_next()

        task.current_item = ""
        db.commit()

        if settings.clean_local_after_transfer and local_root.exists():
            shutil.rmtree(local_root, ignore_errors=True)

    @staticmethod
    def _download_to_local(
        settings: AppSettings, item: FileItem, local_root: Path
    ) -> tuple[Path, int]:
        # Use one OpenList client per worker thread to avoid shared-session races.
        client = OpenListClient(
            base_url=settings.openlist_base_url,
            token=settings.openlist_token,
            password=settings.openlist_password,
        )
        local_file = local_root.joinpath(*item.relative_path.split("/"))
        size = client.download_file(item.remote_path, str(local_file))
        return local_file, size

    def _upload_to_mobile(
        self,
        *,
        db: Session,
        task: TransferTask,
        settings: AppSettings,
        openlist: OpenListClient,
        mobile_client: MobileCloudClient,
        local_file: Path,
        file_item: FileItem,
        mobile_dir_cache: dict[str, str],
    ) -> None:
        fake_ext = settings.mobile_fake_extension.strip() or ".jpg"
        if not fake_ext.startswith("."):
            fake_ext = "." + fake_ext

        original_name = local_file.name
        fake_name = f"{local_file.stem}{fake_ext}"
        fake_file = local_file.with_name(fake_name)

        # 目标 OpenList 目录，检测重名（包含假后缀名和最终名）
        relative_parent = PurePosixPath(file_item.relative_path).parent.as_posix()
        if relative_parent == ".":
            relative_parent = ""
        target_openlist_dir = join_remote_path(settings.mobile_target_openlist_path, relative_parent)

        def _exists_in_openlist(name: str) -> bool:
            try:
                data = openlist.list_dir(target_openlist_dir, refresh=False, page=1, per_page=0)
                content = data.get("content") or []
                return any(isinstance(it, dict) and it.get("name") == name for it in content)
            except Exception:
                return False

        if _exists_in_openlist(original_name) or _exists_in_openlist(fake_name):
            self._log(
                db,
                task,
                f"Skip upload: target already has file {original_name} or {fake_name} in {target_openlist_dir}",
            )
            if settings.clean_local_after_transfer and local_file.exists():
                local_file.unlink(missing_ok=True)
            return

        os.replace(local_file, fake_file)
        self._log(db, task, f"Mobile upload: rename suffix {original_name} -> {fake_name}")

        target_parent_id = self._ensure_mobile_parent_for_relative_path(
            mobile_client=mobile_client,
            root_parent_id=settings.mobile_parent_file_id,
            relative_dir=relative_parent,
            dir_cache=mobile_dir_cache,
        )

        upload_result = mobile_client.upload_file(
            str(fake_file), parent_file_id=target_parent_id
        )
        self._log(db, task, f"Mobile upload success: file_id={upload_result.file_id}")

        # 统一改名走 OpenList，避免 139 APP 接口对中文/特殊符号校验失败
        target_openlist_file = join_remote_path(target_openlist_dir, upload_result.uploaded_name)
        openlist.rename(target_openlist_file, original_name)
        self._log(
            db,
            task,
            f"OpenList rename success: {target_openlist_file} -> {original_name}",
        )

        if settings.clean_local_after_transfer and fake_file.exists():
            fake_file.unlink(missing_ok=True)

    @staticmethod
    def _ensure_mobile_parent_for_relative_path(
        *,
        mobile_client: MobileCloudClient,
        root_parent_id: str,
        relative_dir: str,
        dir_cache: dict[str, str],
    ) -> str:
        rel = relative_dir.strip().strip("/")
        if rel == "":
            return root_parent_id
        if rel in dir_cache:
            return dir_cache[rel]

        current_parent = root_parent_id
        built = ""
        for part in rel.split("/"):
            built = part if not built else f"{built}/{part}"
            if built in dir_cache:
                current_parent = dir_cache[built]
                continue

            folder_id = ""
            for node in mobile_client.list_dir(current_parent):
                if node.get("is_dir") and str(node.get("name")) == part:
                    folder_id = str(node.get("file_id") or "")
                    break
            if not folder_id:
                folder_id = mobile_client.create_folder(current_parent, part)
            dir_cache[built] = folder_id
            current_parent = folder_id

        return current_parent

    def _expand_source(self, openlist: OpenListClient, source_path: str) -> list[FileItem]:
        source_path = normalize_remote_path(source_path)
        obj = openlist.get_obj(source_path)
        if not isinstance(obj, dict) or not obj:
            raise RuntimeError(f"source path unavailable: {source_path}")
        if not obj.get("is_dir"):
            name = PurePosixPath(source_path).name
            return [FileItem(remote_path=source_path, relative_path=name)]

        root_name = PurePosixPath(source_path).name
        prefix = "" if source_path == "/" else root_name
        files: list[FileItem] = []
        self._walk_dir(openlist=openlist, dir_path=source_path, prefix=prefix, out=files)
        return files

    def _walk_dir(
        self,
        *,
        openlist: OpenListClient,
        dir_path: str,
        prefix: str,
        out: list[FileItem],
    ) -> None:
        data = openlist.list_dir(dir_path, refresh=False, page=1, per_page=0)
        content = data.get("content") or []
        if not isinstance(content, list):
            raise RuntimeError(f"invalid directory listing for path: {dir_path}")
        for item in content:
            if not isinstance(item, dict):
                continue
            name = item.get("name", "")
            if not name:
                continue
            child_path = join_remote_path(dir_path, name)
            child_rel = name if not prefix else f"{prefix}/{name}"
            if item.get("is_dir"):
                self._walk_dir(openlist=openlist, dir_path=child_path, prefix=child_rel, out=out)
            else:
                out.append(FileItem(remote_path=child_path, relative_path=child_rel))

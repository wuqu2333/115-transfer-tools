from __future__ import annotations

import json
import os
import string
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Base, SessionLocal, engine
from .models import AppSettings, TransferTask
from .schemas import (
    CreateTaskRequest,
    MobileListRequest,
    MobileResolveParentRequest,
    OpenListListRequest,
    OpenListLoginRequest,
    RapidUploadRequest,
    SettingsOut,
    SettingsUpdate,
    TransferTaskOut,
)
from .services.openlist_client import OpenListClient, OpenListError, normalize_remote_path
from .services.mobile_cloud_client import MobileCloudClient, MobileCloudError
from .services.transfer_service import TransferWorker, get_or_create_settings

app = FastAPI(title="115 Transfer Tool", version="0.1.0")
worker = TransferWorker(SessionLocal)

STATIC_DIR = Path(__file__).parent / "static"
INDEX_FILE = STATIC_DIR / "index.html"


def _parse_storage_addition(raw: object) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


def _find_mobile_storage(storages: list[dict], target_path: str) -> dict | None:
    best = None
    best_len = -1
    for s in storages:
        mount = normalize_remote_path(str(s.get("mount_path") or "/"))
        driver_name = str(s.get("driver") or "")
        if "139" not in driver_name.lower():
            continue
        if target_path == mount or target_path.startswith(mount.rstrip("/") + "/"):
            if len(mount) > best_len:
                best = s
                best_len = len(mount)
    return best


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def settings_to_schema(model: AppSettings) -> SettingsOut:
    return SettingsOut(
        id=model.id,
        openlist_base_url=model.openlist_base_url,
        openlist_token=model.openlist_token,
        openlist_password=model.openlist_password,
        source_115_root_path=model.source_115_root_path,
        sharepoint_target_path=model.sharepoint_target_path,
        mobile_target_openlist_path=model.mobile_target_openlist_path,
        download_base_path=model.download_base_path,
        mobile_parent_file_id=model.mobile_parent_file_id,
        mobile_authorization=model.mobile_authorization,
        mobile_uni=model.mobile_uni,
        mobile_cloud_host=model.mobile_cloud_host,
        mobile_fake_extension=model.mobile_fake_extension,
        mobile_client_info=model.mobile_client_info,
        mobile_app_channel=model.mobile_app_channel,
        clean_local_after_transfer=model.clean_local_after_transfer,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


def task_to_schema(task: TransferTask) -> TransferTaskOut:
    return TransferTaskOut(
        id=task.id,
        provider=task.provider,
        status=task.status,
        source_paths=json.loads(task.source_paths_json or "[]"),
        source_base_path=task.source_base_path,
        target_path=task.target_path,
        local_download_path=task.local_download_path,
        total_files=task.total_files,
        processed_files=task.processed_files,
        total_bytes=task.total_bytes,
        processed_bytes=task.processed_bytes,
        current_item=task.current_item,
        message=task.message,
        error_message=task.error_message,
        logs=json.loads(task.logs_json or "[]"),
        created_at=task.created_at,
        updated_at=task.updated_at,
        started_at=task.started_at,
        finished_at=task.finished_at,
    )


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        _ = get_or_create_settings(db)
    worker.start()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(INDEX_FILE)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


@app.get("/api/settings", response_model=SettingsOut)
def get_settings(db: Session = Depends(get_db)) -> SettingsOut:
    settings = get_or_create_settings(db)
    return settings_to_schema(settings)


@app.put("/api/settings", response_model=SettingsOut)
def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)) -> SettingsOut:
    settings = get_or_create_settings(db)
    for k, v in payload.model_dump().items():
        setattr(settings, k, v)
    settings.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(settings)
    return settings_to_schema(settings)


@app.post("/api/openlist/login")
def openlist_login(payload: OpenListLoginRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    settings = get_or_create_settings(db)
    if not settings.openlist_base_url:
        raise HTTPException(status_code=400, detail="请先配置 OpenList 地址")
    try:
        token = OpenListClient.login(
            base_url=settings.openlist_base_url,
            username=payload.username,
            password=payload.password,
        )
    except OpenListError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if payload.save_to_settings:
        settings.openlist_token = token
        settings.updated_at = datetime.utcnow()
        db.commit()
    return {"token": token}


@app.post("/api/openlist/list")
def openlist_list(payload: OpenListListRequest, db: Session = Depends(get_db)) -> dict:
    settings = get_or_create_settings(db)
    if not settings.openlist_base_url or not settings.openlist_token:
        raise HTTPException(status_code=400, detail="OpenList 地址或 token 未配置")
    client = OpenListClient(
        base_url=settings.openlist_base_url,
        token=settings.openlist_token,
        password=payload.password or settings.openlist_password,
    )
    try:
        data = client.list_dir(
            path=payload.path,
            refresh=payload.refresh,
            page=payload.page,
            per_page=payload.per_page,
        )
    except OpenListError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    current = normalize_remote_path(payload.path)
    rows = []
    content = data.get("content") or []
    if not isinstance(content, list):
        raise HTTPException(status_code=400, detail="OpenList 返回的目录格式异常")
    for item in content:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "")
        if not name:
            continue
        full_path = normalize_remote_path(f"{current.rstrip('/')}/{name}")
        rows.append(
            {
                "name": name,
                "path": full_path,
                "is_dir": bool(item.get("is_dir")),
                "size": int(item.get("size", 0)),
                "modified": item.get("modified"),
            }
        )
    return {"path": current, "items": rows, "raw": data}


@app.get("/api/openlist/storages")
def openlist_storages(page: int = 1, per_page: int = 200, db: Session = Depends(get_db)) -> dict:
    settings = get_or_create_settings(db)
    if not settings.openlist_base_url or not settings.openlist_token:
        raise HTTPException(status_code=400, detail="OpenList 地址或 token 未配置")
    client = OpenListClient(
        base_url=settings.openlist_base_url,
        token=settings.openlist_token,
        password=settings.openlist_password,
    )
    try:
        data = client.list_storages(page=page, per_page=per_page)
    except OpenListError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return data


@app.get("/api/localfs/list")
def localfs_list(path: str = "", only_dirs: bool = True) -> dict:
    # Windows 盘符根目录视图
    if os.name == "nt" and not path.strip():
        items = []
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                items.append({"name": drive, "path": drive, "is_dir": True, "size": 0})
        return {"path": "", "parent": "", "items": items}

    # Linux/Android 根目录视图
    if os.name != "nt" and not path.strip():
        path = "/"

    p = Path(path).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"本地路径不存在: {p}")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"本地路径不是目录: {p}")

    items = []
    for child in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        if only_dirs and not child.is_dir():
            continue
        try:
            size = child.stat().st_size if child.is_file() else 0
        except OSError:
            size = 0
        items.append(
            {
                "name": child.name,
                "path": str(child.resolve()),
                "is_dir": child.is_dir(),
                "size": size,
            }
        )
    resolved = p.resolve()
    parent = resolved.parent
    parent_path = str(parent)
    if parent == resolved:
        parent_path = ""
    if os.name == "nt" and str(resolved).endswith(":\\"):
        parent_path = ""
    return {"path": str(resolved), "parent": parent_path, "items": items}


@app.post("/api/mobile/list")
def mobile_list(payload: MobileListRequest, db: Session = Depends(get_db)) -> dict:
    settings = get_or_create_settings(db)
    parent_file_id = (payload.parent_file_id or "").strip()
    if not parent_file_id:
        raise HTTPException(status_code=400, detail="parent_file_id 不能为空")

    authorization = (payload.authorization or settings.mobile_authorization).strip()
    uni = (payload.uni or settings.mobile_uni).strip()
    cloud_host = (payload.cloud_host or settings.mobile_cloud_host).strip()
    app_channel = (payload.app_channel or settings.mobile_app_channel).strip()
    client_info = (payload.client_info or settings.mobile_client_info).strip()

    try:
        client = MobileCloudClient(
            authorization=authorization,
            uni=uni,
            parent_file_id=parent_file_id,
            cloud_host=cloud_host,
            app_channel=app_channel,
            client_info=client_info,
        )
        items = client.list_dir(parent_file_id)
    except MobileCloudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"parent_file_id": parent_file_id, "items": items}


@app.post("/api/mobile/resolve-parent")
def mobile_resolve_parent(
    payload: MobileResolveParentRequest, db: Session = Depends(get_db)
) -> dict:
    settings = get_or_create_settings(db)

    target_path = normalize_remote_path(
        payload.openlist_target_path or settings.mobile_target_openlist_path or "/"
    )
    if not settings.openlist_base_url or not settings.openlist_token:
        raise HTTPException(status_code=400, detail="OpenList 地址或 token 未配置")

    openlist = OpenListClient(
        base_url=settings.openlist_base_url,
        token=settings.openlist_token,
        password=settings.openlist_password,
    )

    try:
        storage_page = openlist.list_storages(page=1, per_page=2000)
    except OpenListError as exc:
        raise HTTPException(status_code=400, detail=f"读取 OpenList 存储失败: {exc}") from exc

    storages = storage_page.get("content") or []
    if not isinstance(storages, list):
        raise HTTPException(status_code=400, detail="OpenList 返回的存储列表格式异常")

    matched_storage = _find_mobile_storage(storages, target_path)
    if not matched_storage:
        raise HTTPException(
            status_code=400,
            detail=f"未找到匹配 {target_path} 的 139 存储挂载，请确认移动云盘已在 OpenList 挂载",
        )

    mount_path = normalize_remote_path(str(matched_storage.get("mount_path") or "/"))
    addition = _parse_storage_addition(matched_storage.get("addition"))
    root_folder_id = str(addition.get("root_folder_id") or "/").strip() or "/"

    # 计算目标路径相对挂载根的目录片段
    relative = ""
    if target_path == mount_path:
        relative = ""
    else:
        relative = target_path[len(mount_path.rstrip("/")) + 1 :]
    segments = [s for s in relative.split("/") if s]

    authorization = (payload.authorization or settings.mobile_authorization).strip()
    uni = (payload.uni or settings.mobile_uni).strip()
    cloud_host = (payload.cloud_host or settings.mobile_cloud_host).strip()
    app_channel = (payload.app_channel or settings.mobile_app_channel).strip()
    client_info = (payload.client_info or settings.mobile_client_info).strip()
    if not authorization or not uni:
        raise HTTPException(
            status_code=400,
            detail="移动云盘参数不完整：请先填写 Authorization 和 x-yun-uni",
        )

    try:
        mobile_client = MobileCloudClient(
            authorization=authorization,
            uni=uni,
            parent_file_id=root_folder_id,
            cloud_host=cloud_host,
            app_channel=app_channel,
            client_info=client_info,
        )
    except MobileCloudError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    current_parent = root_folder_id
    traversed = []
    try:
        for seg in segments:
            items = mobile_client.list_dir(current_parent)
            found = next((x for x in items if x.get("is_dir") and x.get("name") == seg), None)
            if not found:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"目录不存在或无权限: {seg} "
                        f"(已遍历: /{'/'.join(traversed) if traversed else ''}, parent={current_parent})"
                    ),
                )
            current_parent = str(found.get("file_id") or "")
            traversed.append(seg)
            if not current_parent:
                raise HTTPException(status_code=400, detail=f"目录 {seg} 未返回 file_id")
    except MobileCloudError as exc:
        raise HTTPException(status_code=400, detail=f"遍历移动云盘目录失败: {exc}") from exc

    return {
        "openlist_target_path": target_path,
        "mount_path": mount_path,
        "driver": matched_storage.get("driver"),
        "root_folder_id": root_folder_id,
        "resolved_parent_file_id": current_parent,
    }


@app.post("/api/mobile/rapid-upload")
def mobile_rapid_upload(payload: RapidUploadRequest, db: Session = Depends(get_db)) -> dict:
    settings = get_or_create_settings(db)
    if not settings.mobile_authorization or not settings.mobile_uni:
        raise HTTPException(status_code=400, detail="请先配置移动云盘 authorization / x-yun-uni")
    if not payload.items:
        raise HTTPException(status_code=400, detail="items 不能为空")

    target_parent = (payload.parent_file_id or settings.mobile_parent_file_id or "").strip()
    if not target_parent:
        raise HTTPException(status_code=400, detail="缺少 parent_file_id")

    client = MobileCloudClient(
        authorization=settings.mobile_authorization,
        uni=settings.mobile_uni,
        parent_file_id=target_parent,
        cloud_host=settings.mobile_cloud_host,
        app_channel=settings.mobile_app_channel,
        client_info=settings.mobile_client_info,
    )

    results: list[dict[str, str]] = []
    for item in payload.items:
        parent_id = (item.parent_file_id or target_parent).strip()
        try:
            res = client.rapid_upload_only(
                file_name=item.name,
                file_size=item.size,
                content_hash=item.sha256,
                parent_file_id=parent_id,
            )
            results.append(
                {
                    "name": item.name,
                    "status": "hit",
                    "file_id": res.file_id,
                    "upload_id": res.upload_id,
                    "uploaded_name": res.uploaded_name,
                    "parent_file_id": parent_id,
                }
            )
        except MobileCloudError as exc:
            results.append(
                {
                    "name": item.name,
                    "status": "miss",
                    "error": str(exc),
                    "parent_file_id": parent_id,
                }
            )

    return {"parent_file_id": target_parent, "results": results}


@app.post("/api/tasks", response_model=TransferTaskOut)
def create_task(payload: CreateTaskRequest, db: Session = Depends(get_db)) -> TransferTaskOut:
    settings = get_or_create_settings(db)
    source_paths = [normalize_remote_path(p) for p in payload.source_paths if p.strip()]
    if not source_paths:
        raise HTTPException(status_code=400, detail="source_paths 不能为空")

    if settings.openlist_base_url and settings.openlist_token:
        client = OpenListClient(
            base_url=settings.openlist_base_url,
            token=settings.openlist_token,
            password=settings.openlist_password,
        )
        for src in source_paths:
            try:
                _ = client.get_obj(src)
            except OpenListError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"源路径不可用: {src}, {exc}",
                ) from exc

    if payload.provider == "sharepoint":
        default_target = settings.sharepoint_target_path
    else:
        default_target = settings.mobile_target_openlist_path

    target_path = normalize_remote_path(payload.target_path or default_target or "/")
    source_base = normalize_remote_path(payload.source_base_path or settings.source_115_root_path or "/")
    resolved_download_base = (payload.download_base_path or settings.download_base_path or "").strip()
    if not resolved_download_base:
        raise HTTPException(status_code=400, detail="请先配置本地下载目录，或在创建任务时填写下载目录")
    base_download = Path(resolved_download_base)

    task = TransferTask(
        provider=payload.provider,
        status="pending",
        source_paths_json=json.dumps(source_paths, ensure_ascii=False),
        source_base_path=source_base,
        target_path=target_path,
        local_download_path="",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    local_root = (base_download / f"task_{task.id}").resolve()
    local_root.mkdir(parents=True, exist_ok=True)
    task.local_download_path = str(local_root)
    db.commit()
    db.refresh(task)

    worker.enqueue(task.id)
    return task_to_schema(task)


@app.post("/api/tasks/{task_id}/retry", response_model=TransferTaskOut)
def retry_task(task_id: int, db: Session = Depends(get_db)) -> TransferTaskOut:
    task = db.get(TransferTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.status == "running":
        raise HTTPException(status_code=400, detail="任务运行中，不能重试")
    task.status = "pending"
    task.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(task)
    worker.enqueue(task.id)
    return task_to_schema(task)


@app.get("/api/tasks", response_model=list[TransferTaskOut])
def list_tasks(limit: int = 100, db: Session = Depends(get_db)) -> list[TransferTaskOut]:
    stmt = select(TransferTask).order_by(TransferTask.id.desc()).limit(limit)
    rows = db.execute(stmt).scalars().all()
    return [task_to_schema(row) for row in rows]


@app.get("/api/tasks/{task_id}", response_model=TransferTaskOut)
def get_task(task_id: int, db: Session = Depends(get_db)) -> TransferTaskOut:
    task = db.get(TransferTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task_to_schema(task)

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

DEFAULT_PART_SIZE = 100 * 1024 * 1024
LARGE_FILE_PART_SIZE = 512 * 1024 * 1024
LARGE_FILE_THRESHOLD = 30 * 1024 * 1024 * 1024
MAX_PART_INFOS_PER_REQUEST = 100


class MobileCloudError(RuntimeError):
    pass


@dataclass(frozen=True)
class UploadPartSpec:
    part_number: int
    offset: int
    part_size: int

    def to_payload(self) -> dict[str, Any]:
        return {
            "partNumber": self.part_number,
            "partSize": self.part_size,
            "parallelHashCtx": {"partOffset": self.offset},
        }


@dataclass
class MobileUploadResult:
    file_id: str
    upload_id: str
    uploaded_name: str
    file_size: int
    content_hash: str


class _FileSliceReader:
    def __init__(self, file_obj, offset: int, size: int) -> None:
        self._file_obj = file_obj
        self._remaining = size
        self._file_obj.seek(offset)

    def read(self, amount: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        if amount is None or amount < 0 or amount > self._remaining:
            amount = self._remaining
        chunk = self._file_obj.read(amount)
        self._remaining -= len(chunk)
        return chunk


class MobileCloudClient:
    def __init__(
        self,
        *,
        authorization: str,
        uni: str,
        parent_file_id: str,
        cloud_host: str = "https://personal-kd-njs.yun.139.com/hcy",
        app_channel: str = "10000023",
        client_info: str = (
            "1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|"
            "02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|"
        ),
    ) -> None:
        self.authorization = authorization.strip()
        self.uni = uni.strip()
        self.parent_file_id = parent_file_id.strip()
        self.cloud_host = cloud_host.rstrip("/")
        self.app_channel = app_channel
        self.client_info = client_info
        if not self.authorization or not self.uni or not self.parent_file_id:
            raise MobileCloudError(
                "mobile cloud config incomplete: authorization / x-yun-uni / parent_file_id required"
            )

    def _base_headers(self) -> dict[str, str]:
        return {
            "Authorization": self.authorization,
            "x-yun-uni": self.uni,
            "x-yun-api-version": "v1",
            "x-yun-url-type": "1",
            "x-yun-op-type": "1",
            "x-yun-sub-op-type": "100",
            "x-yun-client-info": self.client_info,
            "x-yun-app-channel": self.app_channel,
            "x-huawei-channelSrc": self.app_channel,
            "Accept-Language": "zh-CN",
            "User-Agent": "okhttp/4.12.0",
            "Content-Type": "application/json; charset=UTF-8",
        }

    @staticmethod
    def _sha256(file_path: str) -> str:
        h = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    @staticmethod
    def _get_part_size(file_size: int) -> int:
        if file_size > LARGE_FILE_THRESHOLD:
            return LARGE_FILE_PART_SIZE
        return DEFAULT_PART_SIZE

    @classmethod
    def _build_part_specs(cls, file_size: int) -> list[UploadPartSpec]:
        part_size = cls._get_part_size(file_size)
        specs: list[UploadPartSpec] = []
        if file_size <= 0:
            specs.append(UploadPartSpec(part_number=1, offset=0, part_size=0))
            return specs

        offset = 0
        part_number = 1
        while offset < file_size:
            current_size = min(part_size, file_size - offset)
            specs.append(
                UploadPartSpec(
                    part_number=part_number,
                    offset=offset,
                    part_size=current_size,
                )
            )
            offset += current_size
            part_number += 1
        return specs

    def _request_json(
        self,
        method: str,
        endpoint: str,
        *,
        payload: dict[str, Any] | None = None,
        timeout: int = 30,
    ) -> dict[str, Any]:
        url = f"{self.cloud_host}{endpoint}"
        resp = requests.request(
            method,
            url,
            headers=self._base_headers(),
            json=payload,
            timeout=timeout,
        )
        try:
            data = resp.json()
        except ValueError as exc:
            raise MobileCloudError(f"non-JSON response: {url}, HTTP {resp.status_code}") from exc
        if resp.status_code >= 400:
            raise MobileCloudError(f"request failed: {url}, HTTP {resp.status_code}, response={data}")
        if not data.get("success", False):
            raise MobileCloudError(f"接口返回失败: {url}, 响应={data}")
        return data

    @staticmethod
    def _extract_upload_urls(raw_part_infos: Any) -> dict[int, str]:
        upload_urls: dict[int, str] = {}
        if not isinstance(raw_part_infos, list):
            return upload_urls
        for part in raw_part_infos:
            if not isinstance(part, dict):
                continue
            part_num = part.get("partNumber")
            url = part.get("uploadUrl")
            if part_num and url:
                upload_urls[int(part_num)] = str(url)
        return upload_urls

    def _create_upload(
        self,
        *,
        file_name: str,
        file_size: int,
        content_hash: str,
        parent_file_id: str,
        part_specs: list[UploadPartSpec],
    ) -> tuple[str, str, dict[int, str], bool, str]:
        now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.000+08:00")
        payload = {
            "contentHash": content_hash,
            "contentHashAlgorithm": "SHA256",
            "contentType": "application/octet-stream",
            "fileRenameMode": "force_rename",
            "localCreatedAt": now_str,
            "name": file_name,
            "parallelUpload": False,
            "parentFileId": parent_file_id,
            "partInfos": [part.to_payload() for part in part_specs[:MAX_PART_INFOS_PER_REQUEST]],
            "size": file_size,
            "storyVideoFile": False,
            "type": "file",
            "userRegion": {"cityCode": "731", "provinceCode": "731"},
        }
        data = self._request_json("POST", "/file/create", payload=payload)
        result = data.get("data", {}) if isinstance(data.get("data"), dict) else {}

        rapid_upload = bool(result.get("rapidUpload", False))
        exist = bool(result.get("exist", False))
        upload_id = str(result.get("uploadId") or "")
        file_id = str(result.get("fileId") or "")
        upload_urls = self._extract_upload_urls(result.get("partInfos"))

        if not file_id:
            raise MobileCloudError(f"file/create missing fileId: {data}")
        if exist:
            rapid_upload = True
        if not rapid_upload and not upload_id and not upload_urls:
            rapid_upload = True
        if not rapid_upload and not upload_id:
            raise MobileCloudError(f"file/create missing uploadId: {data}")

        uploaded_name = str(result.get("name") or result.get("fileName") or file_name)
        return upload_id, file_id, upload_urls, rapid_upload, uploaded_name

    def _get_upload_urls(
        self,
        *,
        file_id: str,
        upload_id: str,
        part_specs: list[UploadPartSpec],
    ) -> dict[int, str]:
        payload = {
            "fileId": file_id,
            "uploadId": upload_id,
            "partInfos": [part.to_payload() for part in part_specs],
        }
        data = self._request_json("POST", "/file/getUploadUrl", payload=payload)
        result = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
        upload_urls = self._extract_upload_urls(result.get("partInfos"))
        if not upload_urls:
            raise MobileCloudError(f"file/getUploadUrl missing upload urls: {data}")
        return upload_urls

    def _upload_parts(
        self,
        file_path: str,
        part_specs: list[UploadPartSpec],
        upload_urls: dict[int, str],
    ) -> None:
        if not part_specs:
            return

        with open(file_path, "rb") as f:
            for part in part_specs:
                upload_url = upload_urls.get(part.part_number)
                if not upload_url:
                    raise MobileCloudError(f"missing upload url for part {part.part_number}")
                body = _FileSliceReader(f, part.offset, part.part_size)
                resp = requests.put(
                    upload_url,
                    data=body,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "Content-Length": str(part.part_size),
                        "Origin": "https://yun.139.com",
                        "Referer": "https://yun.139.com/",
                    },
                    timeout=600,
                )
                if resp.status_code not in (200, 201):
                    raise MobileCloudError(
                        f"part upload failed: part={part.part_number}, http={resp.status_code}, body={resp.text[:200]}"
                    )

    def _complete_upload(self, upload_id: str, file_id: str, content_hash: str) -> None:
        payload = {
            "contentHash": content_hash,
            "contentHashAlgorithm": "SHA256",
            "fileId": file_id,
            "uploadId": upload_id,
        }
        self._request_json("POST", "/file/complete", payload=payload)

    def upload_file(self, file_path: str, parent_file_id: str | None = None) -> MobileUploadResult:
        if not Path(file_path).exists():
            raise MobileCloudError(f"local file does not exist: {file_path}")

        file_name = Path(file_path).name
        file_size = os.path.getsize(file_path)
        content_hash = self._sha256(file_path)
        part_specs = self._build_part_specs(file_size)

        target_parent = (parent_file_id or self.parent_file_id or "").strip()
        if not target_parent:
            raise MobileCloudError("upload missing parentFileId")

        upload_id, file_id, upload_urls, rapid_upload, uploaded_name = self._create_upload(
            file_name=file_name,
            file_size=file_size,
            content_hash=content_hash,
            parent_file_id=target_parent,
            part_specs=part_specs,
        )

        if not rapid_upload:
            first_batch = part_specs[:MAX_PART_INFOS_PER_REQUEST]
            if first_batch:
                first_batch_urls = upload_urls or self._get_upload_urls(
                    file_id=file_id,
                    upload_id=upload_id,
                    part_specs=first_batch,
                )
                self._upload_parts(file_path, first_batch, first_batch_urls)

            for start in range(MAX_PART_INFOS_PER_REQUEST, len(part_specs), MAX_PART_INFOS_PER_REQUEST):
                batch = part_specs[start : start + MAX_PART_INFOS_PER_REQUEST]
                batch_urls = self._get_upload_urls(
                    file_id=file_id,
                    upload_id=upload_id,
                    part_specs=batch,
                )
                self._upload_parts(file_path, batch, batch_urls)

            self._complete_upload(upload_id, file_id, content_hash)

        return MobileUploadResult(
            file_id=file_id,
            upload_id=upload_id,
            uploaded_name=uploaded_name,
            file_size=file_size,
            content_hash=content_hash,
        )

    def rapid_upload_only(
        self,
        *,
        file_name: str,
        file_size: int,
        content_hash: str,
        parent_file_id: str | None = None,
    ) -> MobileUploadResult:
        part_specs = self._build_part_specs(file_size)
        target_parent = (parent_file_id or self.parent_file_id or "").strip()
        if not target_parent:
            raise MobileCloudError("upload missing parentFileId")

        upload_id, file_id, upload_urls, rapid_upload, uploaded_name = self._create_upload(
            file_name=file_name,
            file_size=file_size,
            content_hash=content_hash,
            parent_file_id=target_parent,
            part_specs=part_specs,
        )
        if not rapid_upload:
            raise MobileCloudError("秒传未命中，需要实际上传文件数据")
        return MobileUploadResult(
            file_id=file_id,
            upload_id=upload_id,
            uploaded_name=uploaded_name,
            file_size=file_size,
            content_hash=content_hash,
        )

    def rename_file(
        self,
        file_id: str,
        new_name: str,
        *,
        parent_file_id: str | None = None,
        max_attempts: int = 5,
        retry_delay_sec: float = 1.2,
    ) -> None:
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                payload = {"fileId": file_id, "name": new_name, "description": ""}
                self._request_json("POST", "/file/update", payload=payload)

                if parent_file_id:
                    matched = next(
                        (
                            item
                            for item in self.list_dir(parent_file_id)
                            if str(item.get("file_id") or "") == file_id
                        ),
                        None,
                    )
                    if matched and str(matched.get("name") or "") == new_name:
                        return
                    if attempt < max_attempts:
                        time.sleep(retry_delay_sec)
                        continue
                    raise MobileCloudError(
                        f"rename verify failed after {max_attempts} attempts: file_id={file_id}, expected={new_name}"
                    )
                return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt >= max_attempts:
                    break
                time.sleep(retry_delay_sec)

        raise MobileCloudError(f"rename failed after retries: {last_error}")

    def create_folder(self, parent_file_id: str, folder_name: str) -> str:
        payload = {
            "parentFileId": parent_file_id,
            "name": folder_name,
            "description": "",
            "type": "folder",
            "fileRenameMode": "force_rename",
        }
        data = self._request_json("POST", "/file/create", payload=payload)
        result = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
        file_id = str(result.get("fileId") or "")
        if not file_id:
            raise MobileCloudError(f"创建目录未返回 fileId: {data}")
        return file_id

    def list_dir(self, parent_file_id: str) -> list[dict[str, Any]]:
        payload = {
            "imageThumbnailStyleList": ["Small", "Large"],
            "orderBy": "updated_at",
            "orderDirection": "DESC",
            "pageInfo": {"pageCursor": "", "pageSize": 100},
            "parentFileId": parent_file_id,
        }
        data = self._request_json("POST", "/file/list", payload=payload)
        result = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
        items = result.get("items") or []
        if not isinstance(items, list):
            raise MobileCloudError(f"list_dir returned invalid items payload: {data}")

        rows: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    "name": item.get("name", ""),
                    "file_id": item.get("fileId", ""),
                    "is_dir": item.get("type") == "folder",
                    "size": int(item.get("size", 0) or 0),
                    "updated_at": item.get("updatedAt"),
                    "created_at": item.get("createdAt"),
                }
            )
        return rows

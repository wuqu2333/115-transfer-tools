from __future__ import annotations

import os
import threading
import time
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote

import requests

DOWNLOAD_START_MIN_INTERVAL_SEC = 2.0
DOWNLOAD_MAX_ATTEMPTS = 5
DOWNLOAD_RETRY_BASE_DELAY_SEC = 15.0

_download_start_lock = threading.Lock()
_last_download_start_at = 0.0


class OpenListError(RuntimeError):
    pass


def normalize_remote_path(path: str) -> str:
    p = path.strip()
    if not p:
        return "/"
    if not p.startswith("/"):
        p = "/" + p
    return str(PurePosixPath(p))


def join_remote_path(base: str, child: str) -> str:
    base = normalize_remote_path(base)
    if base == "/":
        return normalize_remote_path("/" + child.lstrip("/"))
    return normalize_remote_path(f"{base.rstrip('/')}/{child.lstrip('/')}")


class OpenListClient:
    def __init__(self, base_url: str, token: str, password: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token.strip()
        self.password = password or ""
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": self.token,
                "Content-Type": "application/json",
            }
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        stream: bool = False,
        timeout: int = 60,
    ) -> requests.Response:
        url = f"{self.base_url}{path}"
        return self.session.request(
            method,
            url,
            json=json_body,
            headers=headers,
            stream=stream,
            timeout=timeout,
        )

    @staticmethod
    def _parse_json_response(resp: requests.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError as exc:
            raise OpenListError(f"OpenList 返回非 JSON: HTTP {resp.status_code}") from exc
        if resp.status_code >= 400:
            raise OpenListError(f"OpenList 请求失败: HTTP {resp.status_code}, 响应={data}")
        if data.get("code") != 200:
            raise OpenListError(
                f"OpenList 接口错误: code={data.get('code')}, message={data.get('message')}"
            )
        return data

    @classmethod
    def login(cls, base_url: str, username: str, password: str) -> str:
        url = f"{base_url.rstrip('/')}/api/auth/login"
        resp = requests.post(
            url,
            json={"username": username, "password": password},
            timeout=30,
        )
        try:
            data = resp.json()
        except ValueError as exc:
            raise OpenListError(f"OpenList 登录返回非 JSON: HTTP {resp.status_code}") from exc
        if resp.status_code >= 400 or data.get("code") != 200:
            raise OpenListError(f"OpenList 登录失败: {data}")
        token = data.get("data", {}).get("token")
        if not token:
            raise OpenListError("OpenList 登录成功但未返回 token")
        return token

    def list_dir(
        self,
        path: str,
        *,
        refresh: bool = False,
        page: int = 1,
        per_page: int = 0,
    ) -> dict[str, Any]:
        req = {
            "path": normalize_remote_path(path),
            "password": self.password,
            "refresh": refresh,
            "page": page,
            "per_page": per_page,
        }
        resp = self._request("POST", "/api/fs/list", json_body=req)
        return self._parse_json_response(resp)["data"]

    def get_obj(self, path: str) -> dict[str, Any]:
        req = {"path": normalize_remote_path(path), "password": self.password}
        resp = self._request("POST", "/api/fs/get", json_body=req)
        return self._parse_json_response(resp)["data"]

    def mkdir(self, path: str) -> None:
        req = {"path": normalize_remote_path(path)}
        resp = self._request("POST", "/api/fs/mkdir", json_body=req)
        data = (
            resp.json()
            if resp.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        if resp.status_code >= 400:
            raise OpenListError(f"OpenList 创建目录失败: HTTP {resp.status_code}, 响应={data}")
        if data and data.get("code") != 200:
            msg = str(data.get("message", "")).lower()
            if "exist" in msg or "exists" in msg or "already" in msg:
                return
            raise OpenListError(
                f"OpenList 创建目录失败: code={data.get('code')}, message={data.get('message')}"
            )

    def ensure_dir(self, path: str) -> None:
        normalized = normalize_remote_path(path)
        if normalized == "/":
            return
        current = "/"
        for part in [p for p in normalized.split("/") if p]:
            current = join_remote_path(current, part)
            self.mkdir(current)

    def _build_download_url(self, remote_path: str) -> str:
        normalized = normalize_remote_path(remote_path)
        return f"{self.base_url}/d{quote(normalized, safe='/')}"

    @staticmethod
    def _next_download_retry_delay(attempt: int) -> float:
        return min(DOWNLOAD_RETRY_BASE_DELAY_SEC * attempt, 60.0)

    @staticmethod
    def _should_retry_download(exc: Exception) -> bool:
        message = str(exc).lower()
        if isinstance(exc, requests.RequestException):
            return True
        return "115 pmt user" in message or "http 403" in message

    @staticmethod
    def _wait_for_download_start_slot() -> None:
        global _last_download_start_at
        with _download_start_lock:
            now = time.monotonic()
            wait_sec = DOWNLOAD_START_MIN_INTERVAL_SEC - (now - _last_download_start_at)
            if wait_sec > 0:
                time.sleep(wait_sec)
            _last_download_start_at = time.monotonic()

    def download_file(self, remote_path: str, local_path: str) -> int:
        parent_dir = os.path.dirname(local_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)

        temp_path = f"{local_path}.part"
        last_error: Exception | None = None

        for attempt in range(1, DOWNLOAD_MAX_ATTEMPTS + 1):
            try:
                download_url = self._build_download_url(remote_path)
                self._wait_for_download_start_slot()
                size = 0
                with self.session.get(download_url, stream=True, timeout=120) as resp:
                    if resp.status_code >= 400:
                        raise OpenListError(
                            f"下载失败: {remote_path}, HTTP {resp.status_code}, body={resp.text[:200]}"
                        )
                    with open(temp_path, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=1024 * 1024):
                            if not chunk:
                                continue
                            f.write(chunk)
                            size += len(chunk)
                os.replace(temp_path, local_path)
                return size
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                if attempt >= DOWNLOAD_MAX_ATTEMPTS or not self._should_retry_download(exc):
                    break
                time.sleep(self._next_download_retry_delay(attempt))

        if isinstance(last_error, OpenListError):
            raise last_error
        raise OpenListError(f"下载失败: {remote_path}, error={last_error}") from last_error

    def upload_file(self, local_path: str, remote_file_path: str) -> None:
        remote_file_path = normalize_remote_path(remote_file_path)
        remote_dir = str(PurePosixPath(remote_file_path).parent)
        self.ensure_dir(remote_dir)
        with open(local_path, "rb") as f:
            headers = {
                "Authorization": self.token,
                "File-Path": quote(remote_file_path),
                "Password": self.password,
                "Content-Type": "application/octet-stream",
            }
            resp = requests.put(
                f"{self.base_url}/api/fs/put",
                data=f,
                headers=headers,
                timeout=600,
            )
        _ = self._parse_json_response(resp)

    def rename(self, path: str, new_name: str) -> None:
        payload = {"path": normalize_remote_path(path), "name": new_name}
        resp = self._request("POST", "/api/fs/rename", json_body=payload)
        self._parse_json_response(resp)

    def list_storages(self, page: int = 1, per_page: int = 200) -> dict[str, Any]:
        resp = self._request(
            "GET",
            f"/api/admin/storage/list?page={page}&per_page={per_page}",
            timeout=30,
        )
        return self._parse_json_response(resp)["data"]

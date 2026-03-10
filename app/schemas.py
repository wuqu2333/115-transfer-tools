from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SettingsBase(BaseModel):
    openlist_base_url: str = ""
    openlist_token: str = ""
    openlist_password: str = ""

    source_115_root_path: str = "/"
    sharepoint_target_path: str = "/"
    mobile_target_openlist_path: str = "/"
    download_base_path: str = ""

    mobile_parent_file_id: str = ""
    mobile_authorization: str = ""
    mobile_uni: str = ""
    mobile_cloud_host: str = "https://personal-kd-njs.yun.139.com/hcy"
    mobile_fake_extension: str = ".jpg"
    mobile_client_info: str = (
        "1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|"
        "02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|"
    )
    mobile_app_channel: str = "10000023"

    clean_local_after_transfer: bool = True


class SettingsUpdate(SettingsBase):
    pass


class SettingsOut(SettingsBase):
    id: int
    created_at: datetime
    updated_at: datetime


class OpenListLoginRequest(BaseModel):
    username: str
    password: str
    save_to_settings: bool = True


class OpenListListRequest(BaseModel):
    path: str = "/"
    password: str = ""
    refresh: bool = False
    page: int = 1
    per_page: int = 0


class MobileListRequest(BaseModel):
    parent_file_id: str
    authorization: str = ""
    uni: str = ""
    cloud_host: str = ""
    app_channel: str = ""
    client_info: str = ""


class MobileResolveParentRequest(BaseModel):
    openlist_target_path: str = ""
    authorization: str = ""
    uni: str = ""
    cloud_host: str = ""
    app_channel: str = ""
    client_info: str = ""


class RapidUploadItem(BaseModel):
    name: str
    size: int
    sha256: str = Field(alias="hash")
    parent_file_id: str | None = None

    class Config:
        allow_population_by_field_name = True
        populate_by_name = True


class RapidUploadRequest(BaseModel):
    items: list[RapidUploadItem] = Field(default_factory=list)
    parent_file_id: str | None = None


class CreateTaskRequest(BaseModel):
    provider: Literal["sharepoint", "mobile"]
    source_paths: list[str] = Field(default_factory=list)
    source_base_path: str | None = None
    target_path: str | None = None
    download_base_path: str | None = None


class TransferTaskOut(BaseModel):
    id: int
    provider: str
    status: str
    source_paths: list[str]
    source_base_path: str
    target_path: str
    local_download_path: str
    total_files: int
    processed_files: int
    total_bytes: int
    processed_bytes: int
    current_item: str
    message: str
    error_message: str
    logs: list[str]
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

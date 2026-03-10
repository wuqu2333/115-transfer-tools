from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class AppSettings(Base):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)

    openlist_base_url: Mapped[str] = mapped_column(String(500), default="")
    openlist_token: Mapped[str] = mapped_column(Text, default="")
    openlist_password: Mapped[str] = mapped_column(String(255), default="")

    source_115_root_path: Mapped[str] = mapped_column(String(500), default="/")
    sharepoint_target_path: Mapped[str] = mapped_column(String(500), default="/")
    mobile_target_openlist_path: Mapped[str] = mapped_column(String(500), default="/")
    download_base_path: Mapped[str] = mapped_column(String(1000), default="")

    mobile_parent_file_id: Mapped[str] = mapped_column(String(255), default="")
    mobile_authorization: Mapped[str] = mapped_column(Text, default="")
    mobile_uni: Mapped[str] = mapped_column(String(500), default="")
    mobile_cloud_host: Mapped[str] = mapped_column(
        String(500), default="https://personal-kd-njs.yun.139.com/hcy"
    )
    mobile_fake_extension: Mapped[str] = mapped_column(String(50), default=".jpg")
    mobile_client_info: Mapped[str] = mapped_column(
        Text,
        default=(
            "1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|"
            "02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|"
        ),
    )
    mobile_app_channel: Mapped[str] = mapped_column(String(20), default="10000023")

    clean_local_after_transfer: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class TransferTask(Base):
    __tablename__ = "transfer_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="pending")

    source_paths_json: Mapped[str] = mapped_column(Text, default="[]")
    source_base_path: Mapped[str] = mapped_column(String(500), default="/")
    target_path: Mapped[str] = mapped_column(String(500), default="/")
    local_download_path: Mapped[str] = mapped_column(String(1000), default="")

    total_files: Mapped[int] = mapped_column(Integer, default=0)
    processed_files: Mapped[int] = mapped_column(Integer, default=0)
    total_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    processed_bytes: Mapped[int] = mapped_column(BigInteger, default=0)

    current_item: Mapped[str] = mapped_column(String(1000), default="")
    message: Mapped[str] = mapped_column(Text, default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    logs_json: Mapped[str] = mapped_column(Text, default="[]")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

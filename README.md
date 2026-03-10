# 115 资源搬运工具（Web 管理版）

一个跨平台（Windows / Android-Termux / Docker）的搬运工具，核心流程：

1. `115 -> 世纪互联 SharePoint`  
   通过 OpenList `fs/get` 下载到本地，再通过 OpenList `fs/put` 上传到目标路径。
2. `115 -> 移动云盘`  
   通过 OpenList 下载到本地，先把后缀改为图片后缀（默认 `.jpg`），再走移动云盘 APP API 上传；上传完成后调用移动云盘重命名接口把后缀改回原始文件名，再删除本地文件。

数据库使用 SQLite，记录任务状态、进度和日志。

## 功能清单

- Web 页面管理配置（OpenList 地址/token、下载目录、源路径、目标路径、移动云盘参数）。
- 浏览 OpenList 路径并多选源文件/目录。
- 后台队列执行任务，支持重试。
- 任务记录入库：状态、进度、错误、日志。

## 快速启动（本机）

```powershell
cd D:\Media-tools
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

打开 `http://127.0.0.1:8000`。

## Docker 启动

```powershell
cd D:\Media-tools
docker compose up -d --build
```

打开 `http://127.0.0.1:8000`。

## Android（Termux）思路

1. 安装 Termux 与 Python。
2. 拉取项目并执行与本机类似命令：`pip install -r requirements.txt`，`uvicorn app.main:app --host 0.0.0.0 --port 8000`。
3. 手机浏览器访问 `http://127.0.0.1:8000`（本机）或局域网 IP（跨设备）。

## 关键配置说明

- `OpenList 地址`: 例如 `http://127.0.0.1:5244`
- `OpenList Token`: 管理员 token（可在页面用账号密码自动登录获取）
- `115 源根路径`: 例如 `/115`
- `世纪互联目标路径`: 例如 `/sharepoint/目标目录`
- `移动云盘（OpenList）目标路径`: 用于重命名兜底（OpenList `/fs/rename`）
- `移动云盘 parentFileId / Authorization / x-yun-uni`: 从移动云盘 APP 抓包获得

## 技术说明

- OpenList API 参考：`/api/fs/list`、`/api/fs/get`、`/api/fs/put`、`/api/fs/rename`、`/api/admin/storage/list`
- 移动云盘上传流程参考你桌面的 `139yun_upload_test.py`，并补齐了上传后重命名逻辑。
- 移动云盘重命名接口对齐 OpenList 139 驱动的 `MetaPersonalNew` 分支（`/file/update`）。

## 风险提示

- 移动云盘 APP API 存在风控和协议变动风险，抓包参数失效时需更新 `Authorization/x-yun-uni`。
- OpenList token 失效时，任务会失败并在日志中记录，可重试。


# 115 转存工具（Web 控制台）

多端可运行（Windows / Android-Termux / Docker）的 115 → 世纪互联 / 139 移动云盘 转存工具。

- 115 → 世纪互联 SharePoint：通过 OpenList 先下载到本地，再使用 OpenList 上传到目标路径。
- 115 → 移动云盘：下载后改伪后缀（默认 .jpg）走 APP 上传接口，上传完成后通过 OpenList 重命名回原始文件名。
- 任务、日志与进度保存到 SQLite。

前端已重构为 Vue3 + Vite + Ant Design Vue，后端仍为 FastAPI，静态文件由 `app/static` 提供。

## 目录
- [快速启动（后端）](#快速启动后端)
- [前端开发/构建](#前端开发构建)
- [Docker 启动](#docker-启动)
- [Android/Termux 运行](#androidtermux-运行)
- [关键配置说明](#关键配置说明)
- [技术要点](#技术要点)

## 快速启动（后端）
```powershell
cd D:\Media-tools
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```
打开 `http://127.0.0.1:8000` 访问控制台。

## 前端开发/构建
```powershell
cd frontend
npm install
npm run dev   # 本地预览（默认 http://127.0.0.1:5173）
npm run build # 生成 dist
```
构建后将 `frontend/dist` 内容复制到 `app/static/`（已用于当前版本）。后端重新启动后即可生效。

## Docker 启动
```powershell
cd D:\Media-tools
docker compose up -d --build
```
访问 `http://127.0.0.1:8000`。

## Android/Termux 运行
1. 安装 Termux 与 Python。
2. 克隆项目，执行 `pip install -r requirements.txt`，然后 `uvicorn app.main:app --host 0.0.0.0 --port 8000`。
3. 手机浏览器访问 `http://127.0.0.1:8000`（本机）或局域网 IP。

## 关键配置说明
- **OpenList 地址/Token/密码**：如 `http://127.0.0.1:5244`，可在前端使用登录弹窗获取 Token。
- **115 源根路径**：默认 `/115`。
- **世纪互联目标路径**：OpenList 路径，如 `/sharepoint/目标目录`。
- **移动云盘（OpenList）目标路径**：用于重命名的 OpenList 路径，如 `/移动/上传`。
- **移动云盘 parentFileId / Authorization / x-yun-uni**：从 139 APP 抓包取得。

## 技术要点
- OpenList API：`/api/fs/list`、`/api/fs/get`、`/api/fs/put`、`/api/fs/rename`、`/api/admin/storage/list`。
- 移动云盘上传：伪后缀上传 + OpenList 重命名，避免 APP 接口对中文/特殊符号的限制；上传前检查同名文件自动跳过。
- 下载策略：并发 3，起始间隔 2s，自动重试 115 403。

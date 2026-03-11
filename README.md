# 115 转存工具（Web 控制台）

多端可运行（Windows / Android-Termux / Docker）的 115 → 世纪互联 / 139 移动云盘 转存工具。

- 115 → 世纪互联 SharePoint：通过 OpenList 先下载到本地，再使用 OpenList 上传到目标路径。
- 115 → 移动云盘：下载后改伪后缀（默认 .jpg）走 APP 上传接口，上传完成后通过移动云盘 API 重命名回原始文件名。
- 移动云盘秒传：支持 JSON/文本清单导入，默认以任务模式写入日志。
- 任务、日志与进度保存到 SQLite，任务列表支持实时刷新与删除。
- 源文件浏览“已选路径”会持久化（刷新不丢失）。

前端已重构为 Vue3 + Vite + Ant Design Vue，后端为 Express + TypeScript + better-sqlite3，静态文件由 `frontend/dist` 提供。

## 目录
- [一键启动（Windows）](#一键启动windows)
- [快速启动（后端）](#快速启动后端)
- [前端开发/构建](#前端开发构建)
- [Docker 启动](#docker-启动)
- [Android/Termux 运行](#androidtermux-运行)
- [使用流程](#使用流程)
- [秒传清单格式](#秒传清单格式)
- [关键配置说明](#关键配置说明)
- [技术要点](#技术要点)

## 一键启动（Windows）
```powershell
cd D:\Media-tools
./start.ps1
```
或双击 `start.bat`。启动后会自动构建前端与后端，并打开 `http://127.0.0.1:8000`。

## 快速启动（后端）
```powershell
cd D:\Media-tools\backend-node
npm install
npm run build
npm start
```
打开 `http://127.0.0.1:8000` 访问控制台（默认会读取 `frontend/dist` 作为静态资源）。

## 前端开发/构建
```powershell
cd frontend
npm install
npm run dev   # 本地预览（默认 http://127.0.0.1:5173）
npm run build # 生成 dist
```
构建后 `frontend/dist` 会被后端直接读取，无需手动复制。

## Docker 启动
```powershell
cd D:\Media-tools
docker compose up -d --build
```
访问 `http://127.0.0.1:8000`。

## Android/Termux 运行
1. 安装 Termux 与 Node.js。
2. 克隆项目，进入 `backend-node` 目录，执行 `npm install`、`npm run build`、`npm start`。
3. 手机浏览器访问 `http://127.0.0.1:8000`（本机）或局域网 IP。

## 使用流程
1. 在“基础设置”填写 OpenList 与移动云盘参数，并保存。
2. 打开“源文件浏览”，双击进入目录，勾选需要转运的文件/文件夹。
3. 在“创建转运任务”中选择目标平台与目标路径，创建任务。
4. 到“任务记录”查看进度与日志（可开启实时更新）。
5. 如需秒传，使用“秒传导入”页面提交清单。

## 秒传清单格式
支持 JSON 清单或每行一条的文本格式（`name|size|sha256`），`name` 可为完整路径。

示例：
```
movie.mp4|60906485|6914d7d6f4f55808745ce82d7954c81f1f18cf75ea3e39931955599e2a22dcd6
```

## 关键配置说明
- **OpenList 地址/Token/密码**：如 `http://127.0.0.1:5244`，可在前端使用登录弹窗获取 Token。
- **115 源根路径**：默认 `/115`，源文件浏览默认从此路径起步。
- **世纪互联目标路径**：OpenList 路径，如 `/sharepoint/目标目录`。
- **移动云盘（OpenList）目标路径**：用于去重/匹配目录的 OpenList 路径，建议与父目录 ID 对应。
- **移动云盘父目录 ID（parentFileId）**：移动云盘实际上传根目录，可用“自动解析”从 OpenList 路径换算。
- **移动云盘 Authorization / x-yun-uni**：从 139 APP 抓包取得。
- **移动云盘 API Host / App Channel / client info**：高级参数，默认保持不动。

## 技术要点
- OpenList API：`/api/fs/list`、`/api/fs/get`、`/api/fs/put`、`/api/fs/rename`、`/api/admin/storage/list`。
- 移动云盘上传：伪后缀上传 + 移动云盘 API 重命名，避免 APP 接口对中文/特殊符号的限制；上传前检查同名文件自动跳过。
- 秒传：支持并发与重试，任务模式默认写入 SQLite 日志。
- 下载策略：并发 3，起始间隔 2s，自动重试 115 403。

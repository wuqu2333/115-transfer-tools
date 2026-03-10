const state = {
  settings: null,
  currentPath: "/",
  browserItems: [],
  selectedPaths: new Set(),
  tasks: [],
  activeTaskId: null,
  taskPollTimer: null,
  dirPicker: {
    mode: "openlist", // openlist | localfs
    targetInputName: "",
    targetElementId: "",
    title: "选择目录",
    currentPath: "/",
    parentPath: "/",
    items: [],
  },
  mobilePicker: {
    targetInputName: "mobile_parent_file_id",
    currentParentId: "",
    history: [],
    items: [],
  },
};

const DIR_PICKER_MODE = {
  OPENLIST: "openlist",
  LOCALFS: "localfs",
};

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function openDialogSafe(dialog, displayStyle = "block") {
  if (!dialog) return;
  dialog.style.display = displayStyle;
  try {
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
      return;
    }
  } catch (_e) {
    // fallback below
  }
  dialog.setAttribute("open", "");
}

function closeDialogSafe(dialog) {
  if (!dialog) return;
  try {
    if (dialog.open) dialog.close();
  } catch (_e) {
    // ignore
  }
  dialog.removeAttribute("open");
  dialog.style.display = "none";
}

function bindDialogLifecycle(dialog) {
  if (!dialog) return;
  dialog.addEventListener("close", () => {
    dialog.style.display = "none";
    dialog.removeAttribute("open");
  });
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialogSafe(dialog);
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = j.detail || JSON.stringify(j);
    } catch (_e) {
      detail = await resp.text();
    }
    throw new Error(detail);
  }
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return resp.json();
  return null;
}

function getSettingInput(name) {
  return document.querySelector(`#settings-form [name="${name}"]`);
}

function setSettingValue(name, value) {
  const input = getSettingInput(name);
  if (!input) return;
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = value ?? "";
}

function getSettingValue(name) {
  const input = getSettingInput(name);
  if (!input) return "";
  if (input.type === "checkbox") return input.checked;
  return String(input.value ?? "").trim();
}

function setFormValues(settings) {
  const form = document.getElementById("settings-form");
  for (const [k, v] of Object.entries(settings)) {
    const input = form.elements.namedItem(k);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(v);
    else input.value = v ?? "";
  }
}

function getFormPayload() {
  const form = document.getElementById("settings-form");
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") data[el.name] = el.checked;
    else data[el.name] = el.value ?? "";
  }
  return data;
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Number(bytes || 0);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function parentPath(path) {
  const p = String(path || "/");
  const parts = p.split("/").filter(Boolean);
  if (!parts.length) return "/";
  parts.pop();
  return "/" + parts.join("/");
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.settings = settings;
  setFormValues(settings);
  if (!document.getElementById("browser-path-input").value) {
    const p = settings.source_115_root_path || "/";
    document.getElementById("browser-path-input").value = p;
    state.currentPath = p;
  }
}

async function saveSettings() {
  const payload = getFormPayload();
  const updated = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  state.settings = updated;
  showToast("设置已保存");
}

function renderSelectedPaths() {
  const box = document.getElementById("selected-paths");
  const arr = [...state.selectedPaths];
  if (!arr.length) {
    box.innerHTML = `<span class="tip">还没有选择任何路径。</span>`;
    return;
  }
  box.innerHTML = arr
    .map(
      (p) =>
        `<span class="pill">${escapeHtml(p)} <button data-remove-path="${escapeHtml(p)}">x</button></span>`
    )
    .join("");
}

async function loadBrowser(path = null) {
  const targetPath = path ?? state.currentPath ?? "/";
  const res = await api("/api/openlist/list", {
    method: "POST",
    body: JSON.stringify({ path: targetPath, refresh: false, page: 1, per_page: 0 }),
  });
  state.currentPath = res.path;
  state.browserItems = res.items || [];
  document.getElementById("browser-path-input").value = state.currentPath;
  renderBrowserTable();
}

function renderBrowserTable() {
  const table = document.getElementById("browser-table");
  const rows = state.browserItems
    .map((it) => {
      const selected = state.selectedPaths.has(it.path);
      return `<tr>
        <td><input type="checkbox" data-select-path="${escapeHtml(it.path)}" ${selected ? "checked" : ""} /></td>
        <td>${it.is_dir ? "📁" : "📄"} ${escapeHtml(it.name)}</td>
        <td>${it.is_dir ? "-" : humanBytes(it.size)}</td>
        <td>${escapeHtml(it.modified || "-")}</td>
        <td>
          ${
            it.is_dir
              ? `<button data-enter-path="${escapeHtml(it.path)}">进入</button>`
              : `<button data-single-select="${escapeHtml(it.path)}">选中</button>`
          }
        </td>
      </tr>`;
    })
    .join("");
  table.innerHTML = `<table>
    <thead>
      <tr><th>选中</th><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="5">目录为空</td></tr>'}</tbody>
  </table>`;
}

function statusBadge(status) {
  const map = {
    pending: "badge",
    running: "badge running",
    success: "badge success",
    failed: "badge failed",
  };
  const cls = map[status] || "badge";
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function renderTasks() {
  const wrap = document.getElementById("task-table");
  const rows = state.tasks
    .map((t) => {
      const progress =
        t.total_files > 0 ? `${t.processed_files}/${t.total_files}` : `${t.processed_files}/-`;
      return `<tr data-task-row="${t.id}">
        <td>#${t.id}</td>
        <td>${t.provider === "sharepoint" ? "世纪互联" : "移动云盘"}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${escapeHtml(progress)}</td>
        <td>${escapeHtml(t.current_item || "-")}</td>
        <td>${escapeHtml(t.message || "-")}</td>
        <td>${escapeHtml(t.created_at || "-")}</td>
        <td>
          <button data-view-task="${t.id}">日志</button>
          <button data-retry-task="${t.id}">重试</button>
        </td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>ID</th><th>目标</th><th>状态</th><th>进度</th><th>当前项</th><th>消息</th><th>创建时间</th><th>操作</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="8">暂无任务</td></tr>'}</tbody>
  </table>`;
}

function renderActiveTaskLog() {
  const logView = document.getElementById("task-log-view");
  if (!state.activeTaskId) {
    logView.textContent = "点击任务查看日志...";
    return;
  }
  const task = state.tasks.find((x) => x.id === state.activeTaskId);
  if (!task) {
    logView.textContent = "任务不存在或已被清理。";
    return;
  }
  logView.textContent = (task.logs || []).join("\n") || "暂无日志";
}

async function loadTasks() {
  const tasks = await api("/api/tasks?limit=120");
  state.tasks = tasks || [];
  renderTasks();
  renderActiveTaskLog();
}

async function createTask() {
  const selected = [...state.selectedPaths];
  if (!selected.length) throw new Error("请先至少选择一个源路径");

  const provider = document.getElementById("provider-select").value;
  const targetPath = document.getElementById("task-target-path").value.trim();
  const downloadPath = document.getElementById("task-download-path").value.trim();
  const payload = {
    provider,
    source_paths: selected,
    source_base_path: state.settings?.source_115_root_path || "/",
    target_path: targetPath || null,
    download_base_path: downloadPath || null,
  };

  const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
  state.activeTaskId = task.id;
  showToast(`任务 #${task.id} 已创建`);
  await loadTasks();
}

async function retryTask(taskId) {
  await api(`/api/tasks/${taskId}/retry`, { method: "POST" });
  showToast(`任务 #${taskId} 已重新入队`);
  await loadTasks();
}

async function submitOpenListLogin(username, password) {
  await api("/api/openlist/login", {
    method: "POST",
    body: JSON.stringify({ username, password, save_to_settings: true }),
  });
  showToast("登录成功，token 已写入设置");
  await loadSettings();
}

function openDirPicker({ mode, title, targetInputName = "", targetElementId = "", initialPath }) {
  const dialog = document.getElementById("dir-picker-dialog");
  state.dirPicker.mode = mode;
  state.dirPicker.title = title;
  state.dirPicker.targetInputName = targetInputName;
  state.dirPicker.targetElementId = targetElementId;
  state.dirPicker.currentPath = initialPath || (mode === DIR_PICKER_MODE.OPENLIST ? "/" : "");
  state.dirPicker.parentPath = state.dirPicker.currentPath;
  state.dirPicker.items = [];

  document.getElementById("dir-picker-title").textContent = title;
  document.getElementById("dir-picker-path-input").value = state.dirPicker.currentPath;
  renderDirPickerTable();
  openDialogSafe(dialog, "grid");

  loadDirPicker(state.dirPicker.currentPath).catch((err) => {
    showToast(`加载目录失败: ${err.message}`);
  });
}

async function loadDirPicker(path = null) {
  const mode = state.dirPicker.mode;
  const targetPath = path ?? state.dirPicker.currentPath;

  if (mode === DIR_PICKER_MODE.OPENLIST) {
    const res = await api("/api/openlist/list", {
      method: "POST",
      body: JSON.stringify({ path: targetPath || "/", refresh: false, page: 1, per_page: 0 }),
    });
    state.dirPicker.currentPath = res.path;
    state.dirPicker.parentPath = parentPath(res.path);
    state.dirPicker.items = (res.items || []).filter((x) => x.is_dir);
  } else {
    const query = new URLSearchParams({
      path: targetPath || "",
      only_dirs: "true",
    }).toString();
    const res = await api(`/api/localfs/list?${query}`);
    state.dirPicker.currentPath = res.path || "";
    state.dirPicker.parentPath = res.parent ?? "";
    state.dirPicker.items = (res.items || []).filter((x) => x.is_dir);
  }

  document.getElementById("dir-picker-path-input").value = state.dirPicker.currentPath;
  renderDirPickerTable();
}

function renderDirPickerTable() {
  const wrap = document.getElementById("dir-picker-table");
  const rows = state.dirPicker.items
    .map(
      (it) => `<tr>
        <td>📁 ${escapeHtml(it.name)}</td>
        <td>${escapeHtml(it.path)}</td>
        <td>
          <button data-dirpicker-enter="${escapeHtml(it.path)}">进入</button>
          <button data-dirpicker-select="${escapeHtml(it.path)}">选择</button>
        </td>
      </tr>`
    )
    .join("");
  wrap.innerHTML = `<table>
    <thead><tr><th>目录</th><th>路径</th><th>操作</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">目录为空</td></tr>'}</tbody>
  </table>`;
}

function applyDirPickerSelection(path) {
  const targetName = state.dirPicker.targetInputName;
  const targetElementId = state.dirPicker.targetElementId;
  if (!targetName && !targetElementId) return;

  if (targetName) {
    setSettingValue(targetName, path);
    if (targetName === "source_115_root_path") {
      document.getElementById("browser-path-input").value = path || "/";
      state.currentPath = path || "/";
    }
    if (targetName === "mobile_target_openlist_path") {
      resolveMobileParentIdFromTargetPath({ silent: true }).catch((err) => {
        showToast(`目录已选，但自动解析 parentFileId 失败: ${err.message}`);
      });
    }
    showToast(`已设置 ${targetName} = ${path}`);
  }

  if (targetElementId) {
    const el = document.getElementById(targetElementId);
    if (el) {
      el.value = path || "";
      showToast(`已选择: ${path}`);
    }
  }
}

async function resolveMobileParentIdFromTargetPath({ silent = false } = {}) {
  const payload = {
    openlist_target_path: getSettingValue("mobile_target_openlist_path"),
    authorization: getSettingValue("mobile_authorization"),
    uni: getSettingValue("mobile_uni"),
    cloud_host: getSettingValue("mobile_cloud_host"),
    app_channel: getSettingValue("mobile_app_channel"),
    client_info: getSettingValue("mobile_client_info"),
  };
  if (!payload.openlist_target_path) {
    throw new Error("请先填写移动云盘（OpenList）目标路径");
  }

  const res = await api("/api/mobile/resolve-parent", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const fileId = res.resolved_parent_file_id || "";
  if (!fileId) throw new Error("接口未返回 resolved_parent_file_id");

  setSettingValue("mobile_parent_file_id", fileId);
  if (!silent) showToast(`已自动回填 parentFileId: ${fileId}`);
  return res;
}

function openMobilePicker(targetInputName = "mobile_parent_file_id") {
  state.mobilePicker.targetInputName = targetInputName;
  state.mobilePicker.history = [];
  const current = getSettingValue(targetInputName) || "/";
  state.mobilePicker.currentParentId = current;
  document.getElementById("mobile-picker-parent-input").value = current;
  renderMobilePickerTable();
  openDialogSafe(document.getElementById("mobile-picker-dialog"), "grid");
  loadMobilePicker(current).catch((err) => showToast(`加载移动云盘目录失败: ${err.message}`));
}

function buildMobileListPayload(parentFileId) {
  return {
    parent_file_id: parentFileId,
    authorization: getSettingValue("mobile_authorization"),
    uni: getSettingValue("mobile_uni"),
    cloud_host: getSettingValue("mobile_cloud_host"),
    app_channel: getSettingValue("mobile_app_channel"),
    client_info: getSettingValue("mobile_client_info"),
  };
}

async function loadMobilePicker(parentFileId, pushHistory = false) {
  if (!parentFileId) throw new Error("parentFileId 不能为空");
  if (pushHistory && state.mobilePicker.currentParentId) {
    state.mobilePicker.history.push(state.mobilePicker.currentParentId);
  }
  const payload = buildMobileListPayload(parentFileId);
  const res = await api("/api/mobile/list", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.mobilePicker.currentParentId = res.parent_file_id;
  state.mobilePicker.items = res.items || [];
  document.getElementById("mobile-picker-parent-input").value = state.mobilePicker.currentParentId;
  renderMobilePickerTable();
}

function renderMobilePickerTable() {
  const wrap = document.getElementById("mobile-picker-table");
  const rows = (state.mobilePicker.items || [])
    .map((it) => {
      const enterBtn = it.is_dir
        ? `<button data-mobile-enter="${escapeHtml(it.file_id)}">进入</button>`
        : "";
      const chooseBtn = it.is_dir
        ? `<button data-mobile-select="${escapeHtml(it.file_id)}">选择此ID</button>`
        : "";
      return `<tr>
        <td>${it.is_dir ? "📁" : "📄"} ${escapeHtml(it.name || "")}</td>
        <td>${escapeHtml(it.file_id || "")}</td>
        <td>${it.is_dir ? "-" : humanBytes(it.size || 0)}</td>
        <td>${escapeHtml(it.updated_at || "-")}</td>
        <td>${enterBtn} ${chooseBtn}</td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<table>
    <thead><tr><th>名称</th><th>File ID</th><th>大小</th><th>更新时间</th><th>操作</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">目录为空或无权限</td></tr>'}</tbody>
  </table>`;
}

function applyMobileParentSelection(fileId) {
  const targetName = state.mobilePicker.targetInputName;
  const formInput = getSettingInput(targetName);
  if (formInput) {
    setSettingValue(targetName, fileId);
  } else {
    const el = document.getElementById(targetName);
    if (el) el.value = fileId;
  }
  showToast(`已设置 ${targetName} = ${fileId}`);
}

function getTaskDefaultTargetPath(provider) {
  if (provider === "mobile") return getSettingValue("mobile_target_openlist_path") || "/";
  return getSettingValue("sharepoint_target_path") || "/";
}

function parseRapidLines(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) {
      throw new Error(`行格式错误: ${line}`);
    }
    const name = parts[0];
    const size = Number(parts[1]);
    const sha = parts[2].toLowerCase();
    if (!name || !sha || Number.isNaN(size) || size <= 0) {
      throw new Error(`行内容无效: ${line}`);
    }
    items.push({ name, size, sha256: sha });
  }
  return items;
}

function normalizeManifestItem(obj) {
  const name =
    obj.name ||
    obj.path ||
    obj.file ||
    obj.filename ||
    obj.key ||
    "";
  const size =
    obj.size ??
    obj.length ??
    obj.file_size ??
    obj.filesize ??
    obj.bytes ??
    0;
  const sha =
    (obj.sha256 || obj.hash || obj.sha || obj.digest || "").toString().toLowerCase();
  if (!name || !sha || Number.isNaN(Number(size)) || Number(size) <= 0) {
    throw new Error("清单项缺少 name/size/sha256");
  }
  return { name, size: Number(size), sha256: sha };
}

function parseRapidInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  // 优先尝试 JSON
  try {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j)
      ? j
      : Array.isArray(j.data)
        ? j.data
        : Array.isArray(j.content)
          ? j.content
          : null;
    if (arr) {
      return arr.map(normalizeManifestItem);
    }
  } catch (_e) {
    // fall back to line parser
  }
  return parseRapidLines(trimmed);
}

function bindEvents() {
  // 基础设置
  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    try {
      await saveSettings();
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  document.getElementById("pick-source-root-btn").addEventListener("click", () => {
    openDirPicker({
      mode: DIR_PICKER_MODE.OPENLIST,
      title: "选择 115 源根路径（OpenList）",
      targetInputName: "source_115_root_path",
      initialPath: getSettingValue("source_115_root_path") || "/",
    });
  });

  document.getElementById("pick-sharepoint-target-btn").addEventListener("click", () => {
    openDirPicker({
      mode: DIR_PICKER_MODE.OPENLIST,
      title: "选择 世纪互联目标路径（OpenList）",
      targetInputName: "sharepoint_target_path",
      initialPath: getSettingValue("sharepoint_target_path") || "/",
    });
  });

  document.getElementById("pick-mobile-openlist-target-btn").addEventListener("click", () => {
    openDirPicker({
      mode: DIR_PICKER_MODE.OPENLIST,
      title: "选择 移动云盘(OpenList)目标路径",
      targetInputName: "mobile_target_openlist_path",
      initialPath: getSettingValue("mobile_target_openlist_path") || "/",
    });
  });

  document.getElementById("pick-download-path-btn").addEventListener("click", () => {
    openDirPicker({
      mode: DIR_PICKER_MODE.LOCALFS,
      title: "选择本地下载目录",
      targetInputName: "download_base_path",
      initialPath: getSettingValue("download_base_path") || "",
    });
  });

  document.getElementById("pick-mobile-parent-id-btn").addEventListener("click", () => {
    openMobilePicker("mobile_parent_file_id");
  });

  document.getElementById("resolve-mobile-parent-id-btn").addEventListener("click", async () => {
    try {
      await resolveMobileParentIdFromTargetPath({ silent: false });
    } catch (err) {
      showToast(`自动解析失败: ${err.message}`);
    }
  });

  document.getElementById("open-rapid-upload-btn").addEventListener("click", () => {
    const dlg = document.getElementById("rapid-upload-dialog");
    document.getElementById("rapid-parent-id-input").value =
      getSettingValue("mobile_parent_file_id") || "";
    document.getElementById("rapid-upload-text").value = "";
    document.getElementById("rapid-upload-result").textContent = "";
    openDialogSafe(dlg, "block");
  });

  // 创建任务页也改为目录选择
  document.getElementById("pick-task-target-path-btn").addEventListener("click", () => {
    const provider = document.getElementById("provider-select").value;
    const current = document.getElementById("task-target-path").value.trim();
    openDirPicker({
      mode: DIR_PICKER_MODE.OPENLIST,
      title: provider === "mobile" ? "选择移动云盘任务目标路径" : "选择世纪互联任务目标路径",
      targetElementId: "task-target-path",
      initialPath: current || getTaskDefaultTargetPath(provider),
    });
  });

  document.getElementById("pick-task-download-path-btn").addEventListener("click", () => {
    const current = document.getElementById("task-download-path").value.trim();
    openDirPicker({
      mode: DIR_PICKER_MODE.LOCALFS,
      title: "选择任务下载目录",
      targetElementId: "task-download-path",
      initialPath: current || getSettingValue("download_base_path") || "",
    });
  });

  // OpenList 文件浏览器（任务源文件）
  document.getElementById("load-path-btn").addEventListener("click", async () => {
    try {
      await loadBrowser(state.currentPath);
    } catch (err) {
      showToast(`加载失败: ${err.message}`);
    }
  });

  document.getElementById("go-parent-btn").addEventListener("click", async () => {
    try {
      await loadBrowser(parentPath(state.currentPath));
    } catch (err) {
      showToast(`加载失败: ${err.message}`);
    }
  });

  document.getElementById("jump-path-btn").addEventListener("click", async () => {
    try {
      const p = document.getElementById("browser-path-input").value.trim() || "/";
      await loadBrowser(p);
    } catch (err) {
      showToast(`跳转失败: ${err.message}`);
    }
  });

  document.getElementById("clear-selected-btn").addEventListener("click", () => {
    state.selectedPaths.clear();
    renderSelectedPaths();
    renderBrowserTable();
  });

  document.getElementById("browser-table").addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const enterPath = target.getAttribute("data-enter-path");
    if (enterPath) {
      try {
        await loadBrowser(enterPath);
      } catch (err) {
        showToast(`进入失败: ${err.message}`);
      }
      return;
    }

    const single = target.getAttribute("data-single-select");
    if (single) {
      state.selectedPaths.add(single);
      renderSelectedPaths();
      renderBrowserTable();
    }
  });

  document.getElementById("browser-table").addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    const path = target.getAttribute("data-select-path");
    if (!path) return;
    if (target.checked) state.selectedPaths.add(path);
    else state.selectedPaths.delete(path);
    renderSelectedPaths();
  });

  document.getElementById("selected-paths").addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const path = target.getAttribute("data-remove-path");
    if (!path) return;
    state.selectedPaths.delete(path);
    renderSelectedPaths();
    renderBrowserTable();
  });

  // 任务
  document.getElementById("create-task-btn").addEventListener("click", async () => {
    const tip = document.getElementById("create-task-tip");
    try {
      tip.textContent = "正在创建任务...";
      await createTask();
      tip.textContent = "任务已进入队列，后台开始执行。";
    } catch (err) {
      tip.textContent = `创建失败: ${err.message}`;
      showToast(`创建失败: ${err.message}`);
    }
  });

  document.getElementById("refresh-tasks-btn").addEventListener("click", async () => {
    try {
      await loadTasks();
    } catch (err) {
      showToast(`刷新失败: ${err.message}`);
    }
  });

  document.getElementById("task-table").addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const viewTask = target.getAttribute("data-view-task");
    if (viewTask) {
      state.activeTaskId = Number(viewTask);
      renderActiveTaskLog();
      return;
    }

    const retryTaskId = target.getAttribute("data-retry-task");
    if (retryTaskId) {
      try {
        await retryTask(Number(retryTaskId));
      } catch (err) {
        showToast(`重试失败: ${err.message}`);
      }
    }
  });

  // OpenList 登录弹窗
  const loginDialog = document.getElementById("login-dialog");
  bindDialogLifecycle(loginDialog);
  document.getElementById("openlist-login-btn").addEventListener("click", () => {
    openDialogSafe(loginDialog, "block");
  });
  document.getElementById("login-cancel-btn").addEventListener("click", () => {
    closeDialogSafe(loginDialog);
  });
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const username = form.elements.namedItem("username").value;
    const password = form.elements.namedItem("password").value;
    try {
      await submitOpenListLogin(username, password);
      closeDialogSafe(loginDialog);
    } catch (err) {
      showToast(`登录失败: ${err.message}`);
    }
  });

  // 通用目录选择弹窗
  const dirDialog = document.getElementById("dir-picker-dialog");
  bindDialogLifecycle(dirDialog);
  document.getElementById("dir-picker-close-btn").addEventListener("click", () => {
    closeDialogSafe(dirDialog);
  });
  document.getElementById("dir-picker-load-btn").addEventListener("click", async () => {
    try {
      const p = document.getElementById("dir-picker-path-input").value.trim();
      await loadDirPicker(p);
    } catch (err) {
      showToast(`加载目录失败: ${err.message}`);
    }
  });
  document.getElementById("dir-picker-parent-btn").addEventListener("click", async () => {
    try {
      await loadDirPicker(state.dirPicker.parentPath);
    } catch (err) {
      showToast(`进入上级失败: ${err.message}`);
    }
  });
  document.getElementById("dir-picker-select-current-btn").addEventListener("click", () => {
    applyDirPickerSelection(state.dirPicker.currentPath || "");
    closeDialogSafe(dirDialog);
  });
  document.getElementById("dir-picker-table").addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const enter = target.getAttribute("data-dirpicker-enter");
    if (enter) {
      try {
        await loadDirPicker(enter);
      } catch (err) {
        showToast(`进入目录失败: ${err.message}`);
      }
      return;
    }

    const choose = target.getAttribute("data-dirpicker-select");
    if (choose) {
      applyDirPickerSelection(choose);
      closeDialogSafe(dirDialog);
    }
  });

  // 移动云盘 parent id 选择弹窗
  const mobileDialog = document.getElementById("mobile-picker-dialog");
  bindDialogLifecycle(mobileDialog);
  document.getElementById("mobile-picker-close-btn").addEventListener("click", () => {
    closeDialogSafe(mobileDialog);
  });
  document.getElementById("mobile-picker-load-btn").addEventListener("click", async () => {
    try {
      const current = document.getElementById("mobile-picker-parent-input").value.trim();
      await loadMobilePicker(current);
    } catch (err) {
      showToast(`加载移动云盘目录失败: ${err.message}`);
    }
  });
  document.getElementById("mobile-picker-back-btn").addEventListener("click", async () => {
    try {
      if (!state.mobilePicker.history.length) {
        showToast("已经是起始目录");
        return;
      }
      const prev = state.mobilePicker.history.pop();
      await loadMobilePicker(prev, false);
    } catch (err) {
      showToast(`返回失败: ${err.message}`);
    }
  });
  document.getElementById("mobile-picker-select-current-btn").addEventListener("click", () => {
    applyMobileParentSelection(state.mobilePicker.currentParentId);
    closeDialogSafe(mobileDialog);
  });
  document.getElementById("mobile-picker-table").addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const enter = target.getAttribute("data-mobile-enter");
    if (enter) {
      try {
        await loadMobilePicker(enter, true);
      } catch (err) {
        showToast(`进入目录失败: ${err.message}`);
      }
      return;
    }

    const choose = target.getAttribute("data-mobile-select");
    if (choose) {
      applyMobileParentSelection(choose);
      closeDialogSafe(mobileDialog);
    }
  });

  // 秒传导入弹窗
  const rapidDialog = document.getElementById("rapid-upload-dialog");
  bindDialogLifecycle(rapidDialog);
  document.getElementById("rapid-upload-close-btn").addEventListener("click", () => {
    closeDialogSafe(rapidDialog);
  });
  document.getElementById("rapid-pick-parent-btn").addEventListener("click", () => {
    state.mobilePicker.targetInputName = "rapid-parent-id-input";
    state.mobilePicker.history = [];
    const current = document.getElementById("rapid-parent-id-input").value.trim() || getSettingValue("mobile_parent_file_id") || "/";
    state.mobilePicker.currentParentId = current;
    document.getElementById("mobile-picker-parent-input").value = current;
    openDialogSafe(document.getElementById("mobile-picker-dialog"), "grid");
    loadMobilePicker(current).catch((err) => showToast(`加载移动云盘目录失败: ${err.message}`));
  });
  document.getElementById("rapid-upload-submit-btn").addEventListener("click", async () => {
    const parentId =
      document.getElementById("rapid-parent-id-input").value.trim() ||
      getSettingValue("mobile_parent_file_id") ||
      "";
    const text = document.getElementById("rapid-upload-text").value;
    try {
      const items = parseRapidInput(text);
      if (!parentId) throw new Error("parentFileId 不能为空，请先选择或填写");
      const res = await api("/api/mobile/rapid-upload", {
        method: "POST",
        body: JSON.stringify({ parent_file_id: parentId, items }),
      });
      const lines = (res.results || []).map((r) => {
        if (r.status === "hit") {
          return `✅ ${r.name} -> fileId=${r.file_id}`;
        }
        return `❌ ${r.name} -> ${r.error}`;
      });
      document.getElementById("rapid-upload-result").textContent =
        lines.join("\n") || "无返回结果";
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("rapid-upload-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = parseRapidInput(text);
      if (!items.length) throw new Error("文件中未解析到有效条目");
      document.getElementById("rapid-upload-text").value = items
        .map((i) => `${i.name}|${i.size}|${i.sha256}`)
        .join("\n");
      showToast(`已从文件读取 ${items.length} 条清单`);
    } catch (err) {
      showToast(`读取文件失败: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  });
}

async function bootstrap() {
  bindEvents();
  renderSelectedPaths();
  try {
    await loadSettings();
    await loadBrowser(state.currentPath || "/");
    await loadTasks();
  } catch (err) {
    showToast(`初始化失败: ${err.message}`);
  }

  if (state.taskPollTimer) clearInterval(state.taskPollTimer);
  state.taskPollTimer = setInterval(async () => {
    try {
      await loadTasks();
    } catch (_e) {
      // ignore polling errors
    }
  }, 5000);
}

bootstrap();

<script setup lang="ts">
import { onMounted, reactive, ref, h } from "vue";
import { useSettingsStore } from "../stores/settings";
import { request } from "../api/request";
import { NButton, useMessage, type DataTableColumns } from "naive-ui";

interface PickerItem {
  name: string;
  path: string;
  is_dir: boolean;
}

const text = {
  title: "基础设置",
  openlistBase: "OpenList 地址",
  openlistToken: "OpenList Token",
  openlistPassword: "OpenList 共享密码",
  openlistUsername: "OpenList 账号",
  openlistLoginPassword: "OpenList 密码",
  openlistTokenFetchOk: "已获取 OpenList Token",
  openlistTokenFetchFail: "获取 Token 失败",
  source115Cookie: "115 Cookie",
  source115CookiePlaceholder: "用于 115 相关接口（仅保存本地）",
  sourceRoot: "115 源根路径",
  sharepointTarget: "世纪互联目标路径",
  sharepointCard: "世纪互联空间",
  sharepointTenantId: "Tenant ID",
  sharepointClientId: "Client ID",
  sharepointClientSecret: "Client Secret",
  sharepointDriveId: "Drive ID（推荐）",
  sharepointSiteId: "Site ID（可选）",
  sharepointAccessToken: "Access Token（可选）",
  sharepointAccessPlaceholder: "没有应用凭据时，可临时填写 Token",
  mobileTarget: "移动云盘（OpenList）目标路径",
  downloadBase: "本地下载目录",
  minFree: "最小可用空间（GB）",
  downloadPlaceholder: "留空表示启动时再选择",
  downloadSelect: "选择目录",
  downloadSelectTitle: "选择下载目录",
  downloadSelected: "已选择本地目录",
  downloadSelectFail: "选择目录失败",
  mobileCard: "移动云盘",
  treeCard: "目录树",
  treeEnabled: "启用目录树",
  treeFile: "目录树文件",
  treeFilePlaceholder: "选择目录树文件（txt/json/jsonl）",
  treeSelectFile: "选择文件",
  treeRoot: "树根路径",
  treeImport: "导入目录树",
  treeClear: "清空目录树",
  treeImportOk: "目录树导入完成",
  treeImportFail: "目录树导入失败",
  treeClearOk: "目录树已清空",
  treeClearFail: "清空失败",
  treeStatus: "已导入",
  treeStatusEmpty: "尚未导入目录树",
  mobileAuth: "Authorization (必填)",
  mobileAuthPlaceholder: "移动云盘 APP 抓包 Authorization",
  mobileUni: "x-yun-uni (必填)",
  mobileUniPlaceholder: "移动云盘 APP 抓包 x-yun-uni",
  fakeExt: "假后缀",
  fakeExtPlaceholder: "默认 .jpg，上传时强制使用",
  parentId: "移动云盘父目录 ID",
  parentPlaceholder: "通过目录选择自动填入，可留空",
  resolveParent: "自动解析",
  resolveOk: "已解析父目录 ID",
  resolveFail: "解析失败",
  advanced: "高级参数（通常保持默认）",
  cleanLocal: "上传成功后删除本地",
  save: "保存设置",
  saveOk: "设置已保存",
  saveFail: "保存失败",
  selectDir: "选择目录",
  pickerTitle: "选择目录",
  pickerPath: "当前路径",
  pickerJump: "跳转",
  pickerParent: "上一级",
  pickerChoose: "选择当前目录",
  pickerName: "目录名称",
  pickerAction: "操作",
  pickerEnter: "进入",
  openlistFail: "加载目录失败",
};

const message = useMessage();
const store = useSettingsStore();
const formState = reactive<any>({});

const pickerVisible = ref(false);
const pickerPath = ref("/");
const pickerItems = ref<PickerItem[]>([]);
const pickerLoading = ref(false);
const pickerField = ref<string>("");
const pickerTitle = ref("");
const treeStatus = ref<any>({});
const treeBusy = ref(false);

const pickerColumns: DataTableColumns<PickerItem> = [
  { title: text.pickerName, key: "name" },
  {
    title: text.pickerAction,
    key: "action",
    width: 120,
    render: (row) =>
      h(
        NButton,
        { size: "tiny", onClick: () => enterPicker(row) },
        { default: () => text.pickerEnter },
      ),
  },
];

function normalizeRemote(p: string) {
  if (!p) return "/";
  let s = String(p).trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
}

onMounted(async () => {
  await store.fetch();
  const data = { ...(store.data || {}) };
  data.source_115_root_path = normalizeRemote(data.source_115_root_path);
  data.sharepoint_target_path = normalizeRemote(data.sharepoint_target_path);
  data.mobile_target_openlist_path = normalizeRemote(data.mobile_target_openlist_path);
  data.tree_root_prefix = normalizeRemote(data.tree_root_prefix || "/115");
  Object.assign(formState, data);
  loadTreeStatus();
});

async function loadTreeStatus() {
  try {
    const res: any = await request.get("/api/tree/status");
    treeStatus.value = res || {};
    if (!formState.tree_file_path && res?.file_path) {
      formState.tree_file_path = res.file_path;
    }
    if (res?.root_prefix) {
      formState.tree_root_prefix = normalizeRemote(res.root_prefix);
    }
  } catch {
    // ignore
  }
}

async function loadPicker(p?: string) {
  pickerLoading.value = true;
  try {
    const res: any = await request.post("/api/openlist/list", {
      path: p ?? pickerPath.value,
      refresh: false,
      page: 1,
      per_page: 0,
      openlist_base_url: formState.openlist_base_url,
      openlist_token: formState.openlist_token,
      openlist_password: formState.openlist_password,
      openlist_username: formState.openlist_username,
      openlist_login_password: formState.openlist_login_password,
    });
    pickerPath.value = (res as any).path || "/";
    const list = Array.isArray((res as any).items) ? (res as any).items : [];
    pickerItems.value = list.filter((it: any) => it.is_dir);
  } catch (e: any) {
    message.error(e?.message || text.openlistFail);
  } finally {
    pickerLoading.value = false;
  }
}

async function openPicker(field: string, title: string) {
  pickerField.value = field;
  pickerTitle.value = title || text.pickerTitle;
  pickerVisible.value = true;
  const current = (formState as any)[field] || "/";
  await loadPicker(current);
}

function pickCurrent() {
  if (!pickerField.value) return;
  (formState as any)[pickerField.value] = normalizeRemote(pickerPath.value || "/");
  pickerVisible.value = false;
  if (pickerField.value === "mobile_target_openlist_path") {
    resolveMobileParent(true);
  }
}

function goPickerParent() {
  const parts = pickerPath.value.split("/").filter(Boolean);
  parts.pop();
  const parent = "/" + parts.join("/");
  loadPicker(parent || "/");
}

function enterPicker(record: PickerItem) {
  if (record.is_dir) {
    loadPicker(record.path);
  }
}

async function resolveMobileParent(silent = false) {
  if (!formState.openlist_base_url || !formState.openlist_token) return;
  try {
    const res: any = await request.post("/api/mobile/resolve-parent", {
      openlist_target_path: formState.mobile_target_openlist_path || "/",
    });
    if (res?.resolved_parent_file_id) {
      formState.mobile_parent_file_id = res.resolved_parent_file_id;
      if (!silent) message.success(text.resolveOk);
    }
  } catch (e: any) {
    if (!silent) message.error(e?.message || text.resolveFail);
  }
}

async function selectLocalDir() {
  try {
    const res: any = await request.post("/api/system/select-directory", { title: text.downloadSelectTitle });
    if (res?.path) {
      formState.download_base_path = res.path;
      message.success(text.downloadSelected);
    }
  } catch (e: any) {
    message.error(e?.message || text.downloadSelectFail);
  }
}

async function selectTreeFile() {
  try {
    const res: any = await request.post("/api/system/select-file", {
      title: text.treeFile,
      filter: "Tree files (*.txt;*.json;*.jsonl)|*.txt;*.json;*.jsonl|All files (*.*)|*.*",
    });
    if (res?.path) formState.tree_file_path = res.path;
  } catch (e: any) {
    message.error(e?.message || text.downloadSelectFail);
  }
}

async function importTree() {
  if (!formState.tree_file_path) {
    message.error(text.treeFilePlaceholder);
    return;
  }
  treeBusy.value = true;
  try {
    await request.post("/api/tree/import", {
      file_path: formState.tree_file_path,
      root_prefix: normalizeRemote(formState.tree_root_prefix || "/"),
      clear: true,
    });
    message.success(text.treeImportOk);
    loadTreeStatus();
  } catch (e: any) {
    message.error(e?.message || text.treeImportFail);
  } finally {
    treeBusy.value = false;
  }
}

async function clearTree() {
  treeBusy.value = true;
  try {
    await request.post("/api/tree/clear");
    message.success(text.treeClearOk);
    loadTreeStatus();
  } catch (e: any) {
    message.error(e?.message || text.treeClearFail);
  } finally {
    treeBusy.value = false;
  }
}

const onSubmit = async () => {
  try {
    const payload = {
      ...formState,
      source_115_root_path: normalizeRemote(formState.source_115_root_path),
      sharepoint_target_path: normalizeRemote(formState.sharepoint_target_path),
      mobile_target_openlist_path: normalizeRemote(formState.mobile_target_openlist_path),
      tree_root_prefix: normalizeRemote(formState.tree_root_prefix || "/"),
    };
    if (
      !payload.openlist_token &&
      formState.openlist_username &&
      formState.openlist_login_password
    ) {
      const res: any = await request.post("/api/openlist/login", {
        username: formState.openlist_username,
        password: formState.openlist_login_password,
        openlist_base_url: formState.openlist_base_url,
      });
      if (res?.token) {
        payload.openlist_token = res.token;
        formState.openlist_token = res.token;
        message.success(text.openlistTokenFetchOk);
      }
    }
    await store.save(payload);
    message.success(text.saveOk);
  } catch (e: any) {
    message.error(e?.message || text.saveFail);
  }
};
</script>

<template>
  <div class="page-stack">
    <n-card :title="text.title" :bordered="false" class="page-card">
      <n-form label-placement="top">
        <div class="grid-2">
          <n-form-item :label="text.openlistBase">
            <n-input v-model:value="formState.openlist_base_url" />
          </n-form-item>
          <n-form-item :label="text.openlistToken">
            <n-input v-model:value="formState.openlist_token" />
          </n-form-item>
        </div>

        <div class="grid-2">
          <n-form-item :label="text.openlistUsername">
            <n-input v-model:value="formState.openlist_username" />
          </n-form-item>
          <n-form-item :label="text.openlistLoginPassword">
            <n-input v-model:value="formState.openlist_login_password" type="password" show-password-on="click" />
          </n-form-item>
        </div>

        <div class="grid-2">
          <n-form-item :label="text.openlistPassword">
            <n-input v-model:value="formState.openlist_password" />
          </n-form-item>
          <n-form-item :label="text.source115Cookie">
            <n-input v-model:value="formState.source_115_cookie" :placeholder="text.source115CookiePlaceholder" />
          </n-form-item>
        </div>

        <div class="grid-1">
          <n-form-item :label="text.sourceRoot">
            <div class="select-row">
              <n-input v-model:value="formState.source_115_root_path" />
              <n-button @click="() => openPicker('source_115_root_path', text.sourceRoot)">{{ text.selectDir }}</n-button>
            </div>
          </n-form-item>
        </div>

        <div class="grid-2">
          <n-form-item :label="text.sharepointTarget">
            <div class="select-row">
              <n-input v-model:value="formState.sharepoint_target_path" />
              <n-button @click="() => openPicker('sharepoint_target_path', text.sharepointTarget)">{{ text.selectDir }}</n-button>
            </div>
          </n-form-item>
          <n-form-item :label="text.mobileTarget">
            <div class="select-row">
              <n-input v-model:value="formState.mobile_target_openlist_path" />
              <n-button @click="() => openPicker('mobile_target_openlist_path', text.mobileTarget)">{{ text.selectDir }}</n-button>
            </div>
          </n-form-item>
        </div>

        <n-card :title="text.sharepointCard" size="small" :bordered="false" class="sub-card">
          <div class="grid-2">
            <n-form-item :label="text.sharepointTenantId">
              <n-input v-model:value="formState.sharepoint_tenant_id" />
            </n-form-item>
            <n-form-item :label="text.sharepointClientId">
              <n-input v-model:value="formState.sharepoint_client_id" />
            </n-form-item>
          </div>
          <div class="grid-2">
            <n-form-item :label="text.sharepointClientSecret">
              <n-input v-model:value="formState.sharepoint_client_secret" type="password" show-password-on="click" />
            </n-form-item>
            <n-form-item :label="text.sharepointDriveId">
              <n-input v-model:value="formState.sharepoint_drive_id" />
            </n-form-item>
          </div>
          <div class="grid-2">
            <n-form-item :label="text.sharepointSiteId">
              <n-input v-model:value="formState.sharepoint_site_id" />
            </n-form-item>
            <n-form-item :label="text.sharepointAccessToken">
              <n-input v-model:value="formState.sharepoint_access_token" :placeholder="text.sharepointAccessPlaceholder" />
            </n-form-item>
          </div>
        </n-card>

        <div class="grid-1">
          <n-form-item :label="text.downloadBase">
            <div class="select-row">
              <n-input v-model:value="formState.download_base_path" :placeholder="text.downloadPlaceholder" />
              <n-button @click="selectLocalDir">{{ text.downloadSelect }}</n-button>
            </div>
          </n-form-item>
        </div>
        <div class="grid-1">
          <n-form-item :label="text.minFree">
            <n-input-number v-model:value="formState.min_free_gb" :min="1" :max="2048" />
          </n-form-item>
        </div>

        <n-card :title="text.treeCard" size="small" :bordered="false" class="sub-card">
          <div class="grid-1">
            <n-form-item :label="text.treeRoot">
              <n-input v-model:value="formState.tree_root_prefix" />
            </n-form-item>
          </div>
          <div class="grid-1">
            <n-form-item :label="text.treeFile">
              <div class="select-row">
                <n-input v-model:value="formState.tree_file_path" :placeholder="text.treeFilePlaceholder" />
                <n-button @click="selectTreeFile">{{ text.treeSelectFile }}</n-button>
              </div>
            </n-form-item>
          </div>
          <div class="grid-2 tree-actions">
            <n-button type="primary" :loading="treeBusy" @click="importTree">{{ text.treeImport }}</n-button>
            <n-button :loading="treeBusy" @click="clearTree">{{ text.treeClear }}</n-button>
          </div>
          <div class="tree-status">
            <template v-if="treeStatus && (treeStatus.total_files || treeStatus.total_dirs)">
              <n-tag type="success" size="small">
                {{ text.treeStatus }}：{{ treeStatus.total_files }} 文件 / {{ treeStatus.total_dirs }} 目录
              </n-tag>
              <n-text depth="3" class="tree-meta">导入时间：{{ treeStatus.imported_at || "-" }}</n-text>
              <n-text depth="3" class="tree-meta">来源：{{ treeStatus.file_path || "-" }}</n-text>
            </template>
            <n-text v-else depth="3">{{ text.treeStatusEmpty }}</n-text>
          </div>
        </n-card>

        <n-card :title="text.mobileCard" size="small" :bordered="false" class="sub-card">
          <div class="grid-2">
            <n-form-item :label="text.mobileAuth">
              <n-input v-model:value="formState.mobile_authorization" :placeholder="text.mobileAuthPlaceholder" />
            </n-form-item>
            <n-form-item :label="text.mobileUni">
              <n-input v-model:value="formState.mobile_uni" :placeholder="text.mobileUniPlaceholder" />
            </n-form-item>
          </div>
          <div class="grid-2">
            <n-form-item :label="text.fakeExt">
              <n-input v-model:value="formState.mobile_fake_extension" :placeholder="text.fakeExtPlaceholder" />
            </n-form-item>
            <n-form-item :label="text.parentId">
              <div class="select-row">
                <n-input v-model:value="formState.mobile_parent_file_id" :placeholder="text.parentPlaceholder" />
                <n-button @click="() => resolveMobileParent(false)">{{ text.resolveParent }}</n-button>
              </div>
            </n-form-item>
          </div>
          <n-collapse display-directive="show" accordion>
            <n-collapse-item name="adv" :title="text.advanced">
              <div class="grid-2">
                <n-form-item label="API Host">
                  <n-input v-model:value="formState.mobile_cloud_host" />
                </n-form-item>
                <n-form-item label="App Channel">
                  <n-input v-model:value="formState.mobile_app_channel" />
                </n-form-item>
              </div>
              <div class="grid-1">
                <n-form-item label="client info">
                  <n-input v-model:value="formState.mobile_client_info" />
                </n-form-item>
              </div>
            </n-collapse-item>
          </n-collapse>
        </n-card>

        <div class="grid-1" style="margin-top: 12px;">
          <n-form-item :label="text.cleanLocal">
            <n-switch v-model:value="formState.clean_local_after_transfer" />
          </n-form-item>
        </div>

        <n-form-item>
          <n-button type="primary" @click="onSubmit">{{ text.save }}</n-button>
        </n-form-item>
      </n-form>
    </n-card>

    <n-modal v-model:show="pickerVisible" preset="card" :title="pickerTitle" style="width: 720px">
      <div class="picker-bar">
        <n-input v-model:value="pickerPath" :placeholder="text.pickerPath" />
        <n-button @click="() => loadPicker(pickerPath)">{{ text.pickerJump }}</n-button>
        <n-button @click="goPickerParent">{{ text.pickerParent }}</n-button>
        <n-button type="primary" @click="pickCurrent">{{ text.pickerChoose }}</n-button>
      </div>
      <n-data-table
        :columns="pickerColumns"
        :data="pickerItems"
        :loading="pickerLoading"
        :pagination="false"
        :row-key="(row: PickerItem) => row.path"
        :row-props="(row: PickerItem) => ({ onDblclick: () => row.is_dir && enterPicker(row) })"
        size="small"
      />
    </n-modal>
  </div>
</template>

<style scoped>
.sub-card {
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.select-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.grid-1 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.picker-bar {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  margin-bottom: 10px;
}
.tree-actions {
  margin-top: 4px;
}
.tree-status {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.tree-meta {
  display: block;
}
@media (max-width: 720px) {
  .select-row {
    grid-template-columns: 1fr;
  }
  .grid-2 {
    grid-template-columns: 1fr;
  }
  .picker-bar {
    grid-template-columns: 1fr;
  }
}
</style>







<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useSettingsStore } from "../stores/settings";
import { request } from "../api/request";
import { Button, Card, Col, Form, Input, Row, Switch, Collapse, message, Modal, Table } from "ant-design-vue";

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
  sourceRoot: "115 源根路径",
  sharepointTarget: "世纪互联目标路径",
  mobileTarget: "移动云盘（OpenList）目标路径",
  downloadBase: "本地下载目录",
  downloadPlaceholder: "留空表示启动时再选择",
  downloadSelect: "选择目录",
  downloadSelectTitle: "选择下载目录",
  downloadSelected: "已选择本地目录",
  downloadSelectFail: "选择目录失败",
  mobileCard: "移动云盘",
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

const store = useSettingsStore();
const formState = reactive<any>({});

const pickerVisible = ref(false);
const pickerPath = ref("/");
const pickerItems = ref<PickerItem[]>([]);
const pickerLoading = ref(false);
const pickerField = ref<string>("");
const pickerTitle = ref("");

const pickerColumns = [
  { title: text.pickerName, dataIndex: "name" },
  { title: text.pickerAction, dataIndex: "action", width: 120 },
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
  Object.assign(formState, data);
});

async function loadPicker(p?: string) {
  pickerLoading.value = true;
  try {
    const res: any = await request.post("/api/openlist/list", {
      path: p ?? pickerPath.value,
      refresh: false,
      page: 1,
      per_page: 0,
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

const onSubmit = async () => {
  try {
    const payload = {
      ...formState,
      source_115_root_path: normalizeRemote(formState.source_115_root_path),
      sharepoint_target_path: normalizeRemote(formState.sharepoint_target_path),
      mobile_target_openlist_path: normalizeRemote(formState.mobile_target_openlist_path),
    };
    await store.save(payload);
    message.success(text.saveOk);
  } catch (e: any) {
    message.error(e?.message || text.saveFail);
  }
};
</script>

<template>
  <Card :title="text.title" :bordered="false">
    <Form layout="vertical">
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item :label="text.openlistBase">
            <Input v-model:value="formState.openlist_base_url" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item :label="text.openlistToken">
            <Input v-model:value="formState.openlist_token" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item :label="text.openlistPassword">
            <Input v-model:value="formState.openlist_password" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item :label="text.sourceRoot">
            <div class="select-row">
              <Input v-model:value="formState.source_115_root_path" />
              <Button @click="() => openPicker('source_115_root_path', text.sourceRoot)">{{ text.selectDir }}</Button>
            </div>
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item :label="text.sharepointTarget">
            <div class="select-row">
              <Input v-model:value="formState.sharepoint_target_path" />
              <Button @click="() => openPicker('sharepoint_target_path', text.sharepointTarget)">{{ text.selectDir }}</Button>
            </div>
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item :label="text.mobileTarget">
            <div class="select-row">
              <Input v-model:value="formState.mobile_target_openlist_path" />
              <Button @click="() => openPicker('mobile_target_openlist_path', text.mobileTarget)">{{ text.selectDir }}</Button>
            </div>
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item :label="text.downloadBase">
            <div class="select-row">
              <Input v-model:value="formState.download_base_path" :placeholder="text.downloadPlaceholder" />
              <Button @click="selectLocalDir">{{ text.downloadSelect }}</Button>
            </div>
          </Form.Item>
        </Col>
      </Row>

      <Card :title="text.mobileCard" size="small" :bordered="false" class="sub-card">
        <Row :gutter="12">
          <Col :xs="24" :md="12">
            <Form.Item :label="text.mobileAuth">
              <Input v-model:value="formState.mobile_authorization" :placeholder="text.mobileAuthPlaceholder" />
            </Form.Item>
          </Col>
          <Col :xs="24" :md="12">
            <Form.Item :label="text.mobileUni">
              <Input v-model:value="formState.mobile_uni" :placeholder="text.mobileUniPlaceholder" />
            </Form.Item>
          </Col>
        </Row>
        <Row :gutter="12">
          <Col :xs="24" :md="12">
            <Form.Item :label="text.fakeExt">
              <Input v-model:value="formState.mobile_fake_extension" :placeholder="text.fakeExtPlaceholder" />
            </Form.Item>
          </Col>
          <Col :xs="24" :md="12">
            <Form.Item :label="text.parentId">
              <div class="select-row">
                <Input v-model:value="formState.mobile_parent_file_id" :placeholder="text.parentPlaceholder" />
                <Button @click="() => resolveMobileParent(false)">{{ text.resolveParent }}</Button>
              </div>
            </Form.Item>
          </Col>
        </Row>
        <Collapse ghost>
          <Collapse.Panel key="adv" :header="text.advanced">
            <Row :gutter="12">
              <Col :xs="24" :md="12">
                <Form.Item label="API Host">
                  <Input v-model:value="formState.mobile_cloud_host" />
                </Form.Item>
              </Col>
              <Col :xs="24" :md="12">
                <Form.Item label="App Channel">
                  <Input v-model:value="formState.mobile_app_channel" />
                </Form.Item>
              </Col>
            </Row>
            <Row :gutter="12">
              <Col :xs="24" :md="24">
                <Form.Item label="client info">
                  <Input v-model:value="formState.mobile_client_info" />
                </Form.Item>
              </Col>
            </Row>
          </Collapse.Panel>
        </Collapse>
      </Card>

      <Row :gutter="12" style="margin-top: 12px;">
        <Col :xs="24" :md="12">
          <Form.Item :label="text.cleanLocal">
            <Switch v-model:checked="formState.clean_local_after_transfer" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item>
        <Button type="primary" @click="onSubmit">{{ text.save }}</Button>
      </Form.Item>
    </Form>
  </Card>

  <Modal v-model:open="pickerVisible" :title="pickerTitle" :footer="null" width="720">
    <div class="picker-bar">
      <Input v-model:value="pickerPath" :placeholder="text.pickerPath" />
      <Button @click="() => loadPicker(pickerPath)">{{ text.pickerJump }}</Button>
      <Button @click="goPickerParent">{{ text.pickerParent }}</Button>
      <Button type="primary" @click="pickCurrent">{{ text.pickerChoose }}</Button>
    </div>
    <Table
      :columns="pickerColumns"
      :data-source="pickerItems"
      :loading="pickerLoading"
      row-key="path"
      size="small"
      :pagination="false"
      :customRow="(record) => ({ onDblclick: () => (record as any).is_dir && enterPicker(record as any) })"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => enterPicker(record as any)">{{ text.pickerEnter }}</Button>
        </template>
        <template v-else>
          {{ (record as any).name }}
        </template>
      </template>
    </Table>
  </Modal>
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
.picker-bar {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  margin-bottom: 10px;
}
@media (max-width: 720px) {
  .select-row {
    grid-template-columns: 1fr;
  }
  .picker-bar {
    grid-template-columns: 1fr;
  }
}
</style>


<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { Button, Card, Col, Form, Input, Row, Switch, message } from 'ant-design-vue';

const store = useSettingsStore();
const formState = reactive<any>({});

onMounted(async () => {
  await store.fetch();
  Object.assign(formState, store.data || {});
});

const onSubmit = async () => {
  try {
    await store.save(formState);
    message.success('设置已保存');
  } catch (e: any) {
    message.error(e?.message || '保存失败');
  }
};
</script>

<template>
  <Card title="基础设置" :bordered="false">
    <Form layout="vertical">
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="OpenList 地址">
            <Input v-model:value="formState.openlist_base_url" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="OpenList Token">
            <Input v-model:value="formState.openlist_token" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="OpenList 元数据密码">
            <Input v-model:value="formState.openlist_password" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="115 源根路径">
            <Input v-model:value="formState.source_115_root_path" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="世纪互联目标路径">
            <Input v-model:value="formState.sharepoint_target_path" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘（OpenList）目标路径">
            <Input v-model:value="formState.mobile_target_openlist_path" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="本地下载目录">
            <Input v-model:value="formState.download_base_path" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘父目录 ID">
            <Input v-model:value="formState.mobile_parent_file_id" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘 Authorization">
            <Input v-model:value="formState.mobile_authorization" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘 x-yun-uni">
            <Input v-model:value="formState.mobile_uni" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘 API Host">
            <Input v-model:value="formState.mobile_cloud_host" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="伪装后缀">
            <Input v-model:value="formState.mobile_fake_extension" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘 App Channel">
            <Input v-model:value="formState.mobile_app_channel" />
          </Form.Item>
        </Col>
        <Col :xs="24" :md="12">
          <Form.Item label="移动云盘 client info">
            <Input v-model:value="formState.mobile_client_info" />
          </Form.Item>
        </Col>
      </Row>
      <Row :gutter="12">
        <Col :xs="24" :md="12">
          <Form.Item label="上传成功后删除本地">
            <Switch v-model:checked="formState.clean_local_after_transfer" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item>
        <Button type="primary" @click="onSubmit">保存设置</Button>
      </Form.Item>
    </Form>
  </Card>
</template>

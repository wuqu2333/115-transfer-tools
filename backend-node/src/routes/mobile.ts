import { Router } from 'express';
import { getSettings } from '../db';
import { MobileCloudClient } from '../clients/mobile';
import { OpenListClient } from '../clients/openlist';

export const router = Router();

router.post('/mobile/list', async (req, res) => {
  try {
    const settings = getSettings();
    const { parent_file_id, authorization, uni, cloud_host, app_channel, client_info } = req.body || {};
    if (!parent_file_id) return res.status(400).json({ detail: 'parent_file_id 不能为空' });
    const client = new MobileCloudClient(
      authorization || settings.mobile_authorization,
      uni || settings.mobile_uni,
      parent_file_id,
      cloud_host || settings.mobile_cloud_host,
      app_channel || settings.mobile_app_channel,
      client_info || settings.mobile_client_info,
    );
    const items = await client.list_dir(parent_file_id);
    res.json({ parent_file_id, items });
  } catch (e: any) {
    res.status(400).json({ detail: e.message });
  }
});

router.post('/mobile/resolve-parent', async (req, res) => {
  try {
    const settings = getSettings();
    const target_path = req.body?.openlist_target_path || settings.mobile_target_openlist_path || '/';
    if (!settings.openlist_base_url || !settings.openlist_token) return res.status(400).json({ detail: 'OpenList 未配置' });
    const openlist = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
    const storages = (await openlist.listStorages(1, 2000)).content || [];
    const matched = storages.find((s: any) => (s.driver || '').toLowerCase().includes('139') && target_path.startsWith((s.mount_path || '/').replace(/\/$/, '')));
    if (!matched) return res.status(400).json({ detail: '未找到匹配的 139 存储挂载' });
    const mount = matched.mount_path || '/';
    const addition = matched.addition ? JSON.parse(matched.addition) : {};
    const root_folder_id = (addition.root_folder_id || '/').toString();
    const relative = target_path === mount ? '' : target_path.slice(mount.length).replace(/^\//, '');
    const segs = relative.split('/').filter(Boolean);

    const client = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      root_folder_id,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );

    let current = root_folder_id;
    const traversed: string[] = [];
    for (const s of segs) {
      const items = await client.list_dir(current);
      const found = items.find((i: any) => i.is_dir && i.name === s);
      if (!found) throw new Error(`目录不存在: ${s}`);
      current = found.file_id;
      traversed.push(s);
    }
    res.json({
      openlist_target_path: target_path,
      mount_path: mount,
      driver: matched.driver,
      root_folder_id,
      resolved_parent_file_id: current,
    });
  } catch (e: any) {
    res.status(400).json({ detail: e.message });
  }
});

router.post('/mobile/rapid-upload', async (req, res) => {
  try {
    const settings = getSettings();
    if (!settings.mobile_authorization || !settings.mobile_uni) return res.status(400).json({ detail: '请先配置 mobile authorization/uni' });
    const items = req.body?.items || [];
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ detail: 'items 不能为空' });
    const parent = (req.body?.parent_file_id || settings.mobile_parent_file_id || '').trim();
    if (!parent) return res.status(400).json({ detail: '缺少 parent_file_id' });

    const client = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      parent,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );
    const results: any[] = [];
    for (const it of items) {
      try {
        const resu = await client.rapid_upload_only({
          file_name: it.name,
          file_size: Number(it.size || 0),
          content_hash: it.sha256 || it.hash,
          parent_file_id: (it.parent_file_id || parent).trim(),
        });
        results.push({ name: it.name, status: 'hit', file_id: resu.file_id, upload_id: resu.upload_id, uploaded_name: resu.uploaded_name, parent_file_id: it.parent_file_id || parent });
      } catch (err: any) {
        results.push({ name: it.name, status: 'miss', error: err.message, parent_file_id: it.parent_file_id || parent });
      }
    }
    res.json({ parent_file_id: parent, results });
  } catch (e: any) {
    res.status(400).json({ detail: e.message });
  }
});

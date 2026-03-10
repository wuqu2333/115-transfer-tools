import { defineStore } from 'pinia';
import { request } from '../api/request';

export interface Settings {
  openlist_base_url: string;
  openlist_token: string;
  openlist_password: string;
  source_115_root_path: string;
  sharepoint_target_path: string;
  mobile_target_openlist_path: string;
  download_base_path: string;
  mobile_parent_file_id: string;
  mobile_authorization: string;
  mobile_uni: string;
  mobile_cloud_host: string;
  mobile_fake_extension: string;
  mobile_client_info: string;
  mobile_app_channel: string;
  clean_local_after_transfer: boolean;
}

const defaultSettings: Settings = {
  openlist_base_url: '',
  openlist_token: '',
  openlist_password: '',
  source_115_root_path: '/',
  sharepoint_target_path: '/',
  mobile_target_openlist_path: '/',
  download_base_path: '',
  mobile_parent_file_id: '',
  mobile_authorization: '',
  mobile_uni: '',
  mobile_cloud_host: 'https://personal-kd-njs.yun.139.com/hcy',
  mobile_fake_extension: '.jpg',
  mobile_client_info:
    '1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|',
  mobile_app_channel: '10000023',
  clean_local_after_transfer: true,
};

export const useSettingsStore = defineStore('settings', {
  state: (): { data: Settings; loading: boolean } => ({
    data: { ...defaultSettings },
    loading: false,
  }),
  actions: {
    async fetch() {
      this.loading = true;
      try {
        const res = await request.get<Settings>('/api/settings');
        this.data = { ...defaultSettings, ...(res as any) };
      } finally {
        this.loading = false;
      }
    },
    async save(payload: Partial<Settings>) {
      const res = await request.put<Settings>('/api/settings', payload);
      this.data = { ...defaultSettings, ...(res as any) };
    },
  },
});

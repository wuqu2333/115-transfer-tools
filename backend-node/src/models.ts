export interface Settings {
  openlist_base_url: string;
  openlist_token: string;
  openlist_password: string;
  openlist_username: string;
  openlist_login_password: string;
  source_115_cookie: string;
  source_115_root_path: string;
  sharepoint_target_path: string;
  sharepoint_tenant_id: string;
  sharepoint_client_id: string;
  sharepoint_client_secret: string;
  sharepoint_drive_id: string;
  sharepoint_site_id: string;
  sharepoint_access_token: string;
  mobile_target_openlist_path: string;
  download_base_path: string;
  min_free_gb: number;
  mobile_parent_file_id: string;
  mobile_authorization: string;
  mobile_uni: string;
  mobile_cloud_host: string;
  mobile_fake_extension: string;
  mobile_client_info: string;
  mobile_app_channel: string;
  tree_enabled: boolean;
  tree_file_path: string;
  tree_root_prefix: string;
  clean_local_after_transfer: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TaskRow {
  id: number;
  provider: 'sharepoint' | 'mobile' | 'rapid_mobile' | 'mobile_export';
  status: 'pending' | 'running' | 'success' | 'failed' | 'stopped';
  source_paths_json: string;
  source_base_path: string;
  target_path: string;
  local_download_path: string;
  total_files: number;
  processed_files: number;
  total_bytes: number;
  processed_bytes: number;
  current_item: string;
  message: string;
  error_message: string;
  logs_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface FileItem {
  remote_path: string;
  relative_path: string;
  size?: number;
}

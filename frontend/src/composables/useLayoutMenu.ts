import { computed, h } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NIcon } from 'naive-ui'
import {
  DashboardOutlined,
  FolderOutlined,
  ThunderboltOutlined,
  CloudUploadOutlined,
  SettingOutlined,
} from '@vicons/antd'

export function useLayoutMenu() {
  const router = useRouter()
  const route = useRoute()

  const renderIcon = (icon: any) => () => h(NIcon, null, { default: () => h(icon) })

  const menuOptions = [
    { label: '仪表盘', key: 'dashboard', icon: renderIcon(DashboardOutlined) },
    { label: '源文件浏览', key: 'browser', icon: renderIcon(FolderOutlined) },
    { label: '任务记录', key: 'tasks', icon: renderIcon(ThunderboltOutlined) },
    { label: '秒传导入', key: 'rapid', icon: renderIcon(CloudUploadOutlined) },
    { label: '基础设置', key: 'settings', icon: renderIcon(SettingOutlined) },
  ]

  const pageSubtitles: Record<string, string> = {
    dashboard: '转存控制台与快捷入口',
    browser: '选择 115 路径并创建转运任务',
    tasks: '查看任务进度与日志',
    rapid: '导入清单并发起移动云盘秒传',
    settings: '系统连接与参数配置',
  }

  const activeKey = computed(() => (route.name as string) || '')

  const pageTitle = computed(() => {
    const item = menuOptions.find(menu => menu.key === activeKey.value)
    return item?.label || ''
  })

  const pageSubtitle = computed(() => pageSubtitles[activeKey.value] || '')

  const handleMenuSelect = (key: string, onSelect?: () => void) => {
    if (key && route.name !== key) {
      router.push({ name: key })
    }
    if (onSelect) onSelect()
  }

  return {
    activeKey,
    menuOptions,
    pageTitle,
    pageSubtitle,
    handleMenuSelect,
  }
}

export const NAVIGATION_ITEMS = [
  {
    id: 'chat',
    label: 'Trò chuyện',
    icon: '◯',
    available: true,
  },
  {
    id: 'friends',
    label: 'Bạn bè',
    icon: '♧',
    available: true,
  },
  {
    id: 'stories',
    label: 'Story',
    icon: '◌',
    available: true,
  },
  {
    id: 'notifications',
    label: 'Thông báo',
    icon: '♧',
    available: true,
  },
  {
    id: 'settings',
    label: 'Cài đặt',
    icon: '⚙',
    available: true,
  },
  {
    id: 'calls',
    label: 'Cuộc gọi',
    icon: '◉',
    available: true,
  },
]

export const AVAILABLE_NAVIGATION_ITEMS = NAVIGATION_ITEMS.filter(
  (item) => item.available,
)

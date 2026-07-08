// 根据 profile 名称生成稳定、区分度高的颜色。
// 同一个 profile 名在任何页面（侧边栏、页头、仪表盘）都会得到一致的颜色。

const PROFILE_COLORS = [
  '#0f766e', // teal
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
  '#ea580c', // orange
  '#0891b2', // cyan
  '#16a34a', // green
  '#ca8a04', // amber
  '#dc2626', // red
  '#4f46e5', // indigo
];

export function getProfileColor(profile: string): string {
  let hash = 0;
  for (let i = 0; i < profile.length; i++) {
    hash = (hash * 31 + profile.charCodeAt(i)) >>> 0;
  }
  return PROFILE_COLORS[hash % PROFILE_COLORS.length];
}

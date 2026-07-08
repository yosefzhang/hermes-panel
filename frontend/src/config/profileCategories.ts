export interface ProfileCategory {
  key: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
}

export const profileCategories: ProfileCategory[] = [
  {
    key: 'env',
    label: '环境变量',
    sections: [],
  },
  {
    key: 'models',
    label: '模型配置',
    sections: [],
  },
  {
    key: 'channels',
    label: '消息渠道',
    sections: [],
  },
  {
    key: 'skills',
    label: '技能',
    sections: [
      { key: 'skills', label: 'Skills' },
      { key: 'curator', label: 'Curator' },
      { key: 'honcho', label: 'Honcho' },
    ],
  },
  {
    key: 'plugins',
    label: '插件',
    sections: [
      { key: 'plugins', label: 'Plugins' },
      { key: 'hermes_lark_streaming', label: 'Lark Streaming' },
    ],
  },
];

export function findProfileCategory(key: string | null): ProfileCategory {
  return profileCategories.find((category) => category.key === key) || profileCategories[0];
}

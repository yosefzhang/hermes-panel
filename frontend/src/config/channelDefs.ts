// 各消息渠道的表单字段定义

export interface ChannelFieldDef {
  key: string;           // 配置字段名，支持嵌套如 "extra.host"
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'textarea' | 'keyvalue';
  placeholder?: string;
  tooltip?: string;
  required?: boolean;
  defaultValue?: unknown;
}

export interface ChannelTypeDef {
  type: string;
  label: string;
  description: string;
  fields: ChannelFieldDef[];
}

export const CHANNEL_TYPES: ChannelTypeDef[] = [
  {
    type: 'telegram',
    label: 'Telegram',
    description: '通过 Telegram Bot 接收和发送消息',
    fields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF1234gh...', required: true, tooltip: '从 @BotFather 获取的 Bot Token' },
      { key: 'reactions', label: '消息反应', type: 'boolean', defaultValue: false, tooltip: '是否对消息添加 emoji 反应' },
      { key: 'allowed_chats', label: '允许的聊天 ID', type: 'text', placeholder: '留空表示不限制', tooltip: '逗号分隔的聊天 ID，留空为不限制' },
      { key: 'extra.rich_messages', label: '富文本消息', type: 'boolean', defaultValue: true, tooltip: '启用 Markdown 格式的富文本消息' },
    ],
  },
  {
    type: 'discord',
    label: 'Discord',
    description: '通过 Discord Bot 在频道中交互',
    fields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: 'MTAx...', required: true, tooltip: 'Discord Developer Portal 中的 Bot Token' },
      { key: 'require_mention', label: '需要 @提及', type: 'boolean', defaultValue: true, tooltip: '是否需要 @bot 才能触发回复' },
      { key: 'allowed_channels', label: '允许的频道 ID', type: 'text', placeholder: '留空表示所有频道', tooltip: '逗号分隔的频道 ID' },
      { key: 'free_response_channels', label: '自由回复频道', type: 'text', placeholder: '留空表示无', tooltip: '无需 @提及即可回复的频道 ID' },
      { key: 'auto_thread', label: '自动创建线程', type: 'boolean', defaultValue: true, tooltip: '是否自动为回复创建独立线程' },
      { key: 'thread_require_mention', label: '线程中需 @提及', type: 'boolean', defaultValue: false, tooltip: '线程中是否需要 @bot 触发回复' },
      { key: 'history_backfill', label: '回填历史消息', type: 'boolean', defaultValue: true, tooltip: '启动时是否回填历史消息作为上下文' },
      { key: 'history_backfill_limit', label: '回填消息数量', type: 'number', defaultValue: 50, tooltip: '回填的历史消息最大数量' },
      { key: 'reactions', label: '消息反应', type: 'boolean', defaultValue: true, tooltip: '是否对消息添加 emoji 反应' },
      { key: 'dm_role_auth_guild', label: 'DM 权限认证服务器 ID', type: 'text', placeholder: '可选', tooltip: '用于 DM 权限验证的服务器 ID' },
      { key: 'server_actions', label: '服务器操作', type: 'text', placeholder: '可选', tooltip: '允许的服务器管理操作' },
      { key: 'allow_any_attachment', label: '允许任意附件', type: 'boolean', defaultValue: false, tooltip: '是否允许接收任意类型附件' },
      { key: 'max_attachment_bytes', label: '最大附件大小 (字节)', type: 'number', defaultValue: 33554432, tooltip: '默认 32MB' },
    ],
  },
  {
    type: 'slack',
    label: 'Slack',
    description: '通过 Slack Bot 在频道中交互',
    fields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...', tooltip: 'Slack Bot Token（可选）' },
      { key: 'require_mention', label: '需要 @提及', type: 'boolean', defaultValue: true, tooltip: '是否需要 @bot 才能触发回复' },
      { key: 'allowed_channels', label: '允许的频道', type: 'text', placeholder: '逗号分隔，留空表示不限制' },
      { key: 'free_response_channels', label: '自由回复频道', type: 'text', placeholder: '逗号分隔，留空表示无' },
    ],
  },
  {
    type: 'mattermost',
    label: 'Mattermost',
    description: '通过 Mattermost Bot 在团队频道中交互',
    fields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: '可选', tooltip: 'Mattermost Bot Token（可选）' },
      { key: 'require_mention', label: '需要 @提及', type: 'boolean', defaultValue: true },
      { key: 'allowed_channels', label: '允许的频道', type: 'text', placeholder: '逗号分隔，留空表示不限制' },
      { key: 'free_response_channels', label: '自由回复频道', type: 'text', placeholder: '逗号分隔，留空表示无' },
    ],
  },
  {
    type: 'matrix',
    label: 'Matrix',
    description: '通过 Matrix 房间收发消息',
    fields: [
      { key: 'homeserver', label: 'Homeserver', type: 'text', placeholder: 'https://matrix.org', tooltip: 'Matrix 服务器地址（可选）' },
      { key: 'access_token', label: 'Access Token', type: 'password', placeholder: '可选' },
      { key: 'require_mention', label: '需要 @提及', type: 'boolean', defaultValue: true },
      { key: 'allowed_rooms', label: '允许的房间', type: 'text', placeholder: '逗号分隔，留空表示不限制' },
      { key: 'free_response_rooms', label: '自由回复房间', type: 'text', placeholder: '逗号分隔，留空表示无' },
    ],
  },
  {
    type: 'feishu',
    label: '飞书',
    description: '通过飞书开放平台接收和发送消息',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', placeholder: 'cli_...', required: true, tooltip: '飞书开放平台应用的 App ID' },
      { key: 'app_secret', label: 'App Secret', type: 'password', placeholder: '...', required: true, tooltip: '飞书开放平台应用的 App Secret' },
      { key: 'verification_token', label: 'Verification Token', type: 'text', placeholder: '...', tooltip: '飞书事件订阅的 Verification Token' },
      { key: 'encrypt_key', label: 'Encrypt Key', type: 'text', placeholder: '...', tooltip: '飞书事件订阅的加密 Key' },
    ],
  },
  {
    type: 'weixin',
    label: '微信',
    description: '通过微信公众号/企业微信接收和发送消息',
    fields: [
      { key: 'token', label: 'Token', type: 'text', placeholder: '...', required: true, tooltip: '微信公众平台的服务器 Token' },
      { key: 'encoding_aes_key', label: 'EncodingAESKey', type: 'text', placeholder: '...', tooltip: '消息加密密钥（安全模式）' },
    ],
  },
  {
    type: 'webhook',
    label: 'Webhook',
    description: '通过 HTTP Webhook 接收外部系统消息',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean', defaultValue: false },
      { key: 'key', label: '认证密钥', type: 'password', placeholder: '可选', tooltip: 'Webhook 认证密钥' },
      { key: 'cors_origins', label: 'CORS 来源', type: 'text', placeholder: '*', defaultValue: '*', tooltip: '允许的跨域来源' },
      { key: 'extra.host', label: '监听地址', type: 'text', placeholder: '127.0.0.1', defaultValue: '127.0.0.1' },
      { key: 'extra.port', label: '监听端口', type: 'number', placeholder: '9995', defaultValue: 9995 },
    ],
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    description: '通过 WhatsApp Business API 收发消息',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', placeholder: '...', tooltip: 'WhatsApp Business API Key' },
      { key: 'phone_number_id', label: 'Phone Number ID', type: 'text', placeholder: '...', tooltip: 'WhatsApp 电话号码 ID' },
    ],
  },
];

/** 获取某个渠道类型当前已配置的字段名列表（非空字段） */
export function getConfiguredFields(type: string, config: Record<string, unknown>): string[] {
  const def = CHANNEL_TYPES.find((c) => c.type === type);
  if (!def) return [];
  return def.fields
    .filter((f) => {
      const val = getNestedValue(config, f.key);
      return val !== undefined && val !== null && val !== '' && val !== false;
    })
    .map((f) => f.key);
}

/** 从嵌套对象中按路径取值，如 "extra.host" → obj.extra?.host */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const k of keys) {
    if (current && typeof current === 'object' && k in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 设置嵌套值，如 "extra.host" → obj.extra.host = value */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

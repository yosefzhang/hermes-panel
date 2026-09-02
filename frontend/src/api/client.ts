import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import type { LoginResponse, SectionsResponse, User } from '../types';

// 扩展 Axios 配置：`refresh: true` 用于绕过前端 GET 缓存强制刷新
declare module 'axios' {
  export interface AxiosRequestConfig {
    refresh?: boolean;
  }
}

export const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

// ── 前端短时 GET 缓存 ─────────────────────────────────────────────
// 页面之间来回切换时，后端配置型接口会被反复读取。这里对部分 GET 接口
// 做 15s 内存缓存；需要强制刷新时在请求配置里传 `refresh: true` 绕过。
const GET_CACHE_TTL = 15000;
const CACHEABLE_PREFIXES = ['/config', '/channels', '/models', '/skills'];

interface GetCacheItem {
  ts: number;
  value: unknown;
}

const getCache = new Map<string, GetCacheItem>();

function isCacheable(url: string | undefined): boolean {
  if (!url) return false;
  return CACHEABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function sortParams(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const source = params as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = source[key];
  }
  return sorted;
}

function buildCacheKey(config: AxiosRequestConfig): string {
  return `${config.method || 'get'}|${config.url}|${JSON.stringify(sortParams(config.params))}`;
}

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('hermes-panel-token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const method = (config.method || 'get').toLowerCase();
  if (method === 'get' && isCacheable(config.url)) {
    const key = buildCacheKey(config);
    (config as { _cacheKey?: string })._cacheKey = key;
    // refresh: true 时跳过缓存读取（仍会写缓存），用于写操作后的强制刷新
    if (!config.refresh) {
      const hit = getCache.get(key);
      if (hit && Date.now() - hit.ts < GET_CACHE_TTL) {
        // 命中缓存：直接以缓存数据完成请求，不再发起真实网络请求
        config.adapter = () =>
          Promise.resolve({
            data: hit.value,
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
            request: {},
          });
      }
    }
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    const key = (response.config as { _cacheKey?: string })._cacheKey;
    const method = (response.config.method || 'get').toLowerCase();
    if (key && method === 'get' && isCacheable(response.config.url)) {
      getCache.set(key, { ts: Date.now(), value: response.data });
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('hermes-panel-token');
    }
    return Promise.reject(error);
  },
);

export const api = {
  login: async (username: string, password: string) => {
    const { data } = await apiClient.post<LoginResponse>('/auth/login', { username, password });
    return data;
  },
  me: async () => {
    const { data } = await apiClient.get<{ user: User }>('/auth/me');
    return data.user;
  },
  profiles: async () => {
    const { data } = await apiClient.get<{ profiles: string[] }>('/profiles');
    return data.profiles;
  },
  config: async (profile: string) => {
    const { data } = await apiClient.get<Record<string, unknown>>('/config', { params: { profile } });
    return data;
  },
  sections: async (profile: string) => {
    const { data } = await apiClient.get<SectionsResponse>('/config/sections', { params: { profile } });
    return data.sections;
  },
  section: async (profile: string, name: string) => {
    const { data } = await apiClient.get<Record<string, unknown>>(`/config/sections/${name}`, { params: { profile } });
    return data;
  },
  updateSection: async (profile: string, name: string, value: unknown) => {
    const { data } = await apiClient.put<Record<string, unknown>>(`/config/sections/${name}`, value, { params: { profile } });
    return data;
  },
  rawConfig: async (profile: string) => {
    const { data } = await apiClient.get<{ content: string }>('/config/raw', { params: { profile } });
    return data.content;
  },
  updateRawConfig: async (profile: string, content: string) => {
    const { data } = await apiClient.put<{ success: boolean }>('/config/raw', { content }, { params: { profile } });
    return data;
  },
  // ── Skills（只读：列表与详情）──
  // ── Admin (batch operations across profiles) ──
  adminModelsCopy: async (profiles: string[], sourceProfile: string, sections: string[]) => {
    const { data } = await apiClient.post<{ results: Array<{ profile: string; success: boolean; message: string }> }>('/admin/models/copy', { profiles, source_profile: sourceProfile, sections });
    return data.results;
  },
  adminModelsSet: async (profiles: string[], values: Record<string, unknown>) => {
    const { data } = await apiClient.post<{ results: Array<{ profile: string; success: boolean; message: string }> }>('/admin/models/set', { profiles, values });
    return data.results;
  },
  adminSoulBatch: async (profiles: string[], content: string) => {
    const { data } = await apiClient.post<{ results: Array<{ profile: string; success: boolean; message: string }> }>('/admin/soul/batch', { profiles, content });
    return data.results;
  },
  // ── Sync ──
  syncSettings: async () => {
    const { data } = await apiClient.get<{
      enabled: boolean;
      receive_enabled: boolean;
      target_url: string | null;
      send_token: string | null;
      receive_token: string | null;
      interval: number;
      send_endpoints: Array<{ endpoint: string; token: string }>;
    }>('/sync/settings');
    return data;
  },
  updateSyncSettings: async (settings: {
    enabled: boolean;
    receive_enabled?: boolean;
    target_url?: string | null;
    send_token?: string | null;
    receive_token?: string | null;
    interval?: number;
    send_endpoints?: Array<{ endpoint: string; token: string }>;
  }) => {
    const { data } = await apiClient.put<{ ok: boolean; push?: { ok: boolean; message?: string; results?: unknown[] } }>('/sync/settings', settings);
    return data;
  },
  triggerSyncPush: async (endpoint?: string) => {
    const { data } = await apiClient.post<{ ok: boolean; status?: number; message?: string }>(
      '/sync/push',
      null,
      { params: endpoint ? { endpoint } : undefined },
    );
    return data;
  },
  syncStatus: async () => {
    const { data } = await apiClient.get<{
      enabled: boolean;
      enabled_at: number | null;
      uptime_seconds: number;
      last_received_at: number | null;
      last_profiles_count: number;
      total_payloads: number;
      receive_url: string;
      receive_token: string | null;
      port: number;
      panels: Record<
        string,
        {
          last_received_at: number | null;
          last_profiles_count: number;
          total_payloads: number;
        }
      >;
      send: {
        enabled: boolean;
        last_push_at: number | null;
        last_push_ok: boolean | null;
        last_push_message: string | null;
        total_pushes: number;
        total_successes: number;
        total_failures: number;
        endpoints: Record<
          string,
          {
            last_push_at: number | null;
            last_push_ok: boolean | null;
            last_push_message: string | null;
            total_pushes: number;
            total_successes: number;
            total_failures: number;
          }
        >;
      };
    }>('/sync/status');
    return data;
  },
  listAuditLogs: async (limit = 50) => {
    const { data } = await apiClient.get<{ logs: Array<{ id: number; timestamp: number; actor: string; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; success: boolean | null; ip_address: string | null }> }>('/audit-logs', { params: { limit } });
    return data.logs;
  },
  // ── Profile Statistics ──
  profileStats: async (range: string = 'all') => {
    const { data } = await apiClient.get<{
      profiles: Array<{
        id: number;
        profile_name: string;
        path: string | null;
        session_count: number;
        total_tokens: number;
        total_input_tokens: number;
        total_output_tokens: number;
        cache_hit_rate: number;
        model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
        provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
        daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
        updated_at: number;
        source: 'local' | 'remote';
        panel_name: string | null;
      }>;
    }>('/profiles/aggregated', { params: { range } });
    return data;
  },
  refreshProfileStats: async () => {
    const { data } = await apiClient.post<{
      profiles: Array<{
        id: number;
        profile_name: string;
        path: string | null;
        session_count: number;
        total_tokens: number;
        total_input_tokens: number;
        total_output_tokens: number;
        cache_hit_rate: number;
        model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
        provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
        daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
        updated_at: number;
        source: 'local' | 'remote';
        panel_name: string | null;
      }>;
    }>('/profiles/aggregated/refresh');
    return data;
  },
};

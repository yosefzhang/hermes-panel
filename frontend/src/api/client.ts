import axios from 'axios';
import type { LoginResponse, SectionsResponse, User } from '../types';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('hermes-panel-token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
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
  // ── Skills ──
  toggleSkill: async (profile: string, name: string, enabled: boolean) => {
    const { data } = await apiClient.post(`/skills/${name}/toggle`, { enabled }, { params: { profile } });
    return data;
  },
  importSkill: async (profile: string, name: string, content: string, source = 'local') => {
    const { data } = await apiClient.post('/skills/import', { name, content, source }, { params: { profile } });
    return data;
  },
  externalDirs: async (profile: string) => {
    const { data } = await apiClient.get<{ dirs: string[] }>('/skills/external-dirs', { params: { profile } });
    return data.dirs;
  },
  updateExternalDirs: async (profile: string, dirs: string[]) => {
    const { data } = await apiClient.put('/skills/external-dirs', { dirs }, { params: { profile } });
    return data;
  },
  // ── Gateway ──
  gatewayStatus: async (profile?: string) => {
    const params = profile ? { profile } : {};
    const { data } = await apiClient.get<{ statuses: Array<{ profile: string; running: boolean; pid: number | null; state: string | null; platforms: Record<string, unknown>; updated_at: string | null }> }>('/gateway/status', { params });
    return data.statuses;
  },
  gatewayStart: async (profile: string) => {
    const { data } = await apiClient.post<{ success: boolean; message: string; status?: unknown }>('/gateway/start', { profile });
    return data;
  },
  gatewayStop: async (profile: string) => {
    const { data } = await apiClient.post<{ success: boolean; message: string; status?: unknown }>('/gateway/stop', { profile });
    return data;
  },
  gatewayRestart: async (profile: string) => {
    const { data } = await apiClient.post<{ success: boolean; message: string; status?: unknown }>('/gateway/restart', { profile });
    return data;
  },
  // ── Sync ──
  syncSettings: async () => {
    const { data } = await apiClient.get<{
      enabled: boolean;
      receive_enabled: boolean;
      target_url: string | null;
      token: string | null;
      interval: number;
    }>('/sync/settings');
    return data;
  },
  updateSyncSettings: async (settings: {
    enabled: boolean;
    receive_enabled?: boolean;
    target_url?: string | null;
    token?: string | null;
    interval?: number;
  }) => {
    const { data } = await apiClient.put<{ ok: boolean }>('/sync/settings', settings);
    return data;
  },
  verifySyncTarget: async (targetUrl: string, token?: string | null) => {
    const { data } = await apiClient.post<{ ok: boolean; status?: number }>('/sync/verify', {
      target_url: targetUrl,
      token: token || null,
    });
    return data;
  },
  listAuditLogs: async (limit = 50) => {
    const { data } = await apiClient.get<{ logs: Array<{ id: number; timestamp: number; actor: string; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; success: boolean | null; ip_address: string | null }> }>('/audit-logs', { params: { limit } });
    return data.logs;
  },
  // ── Profile Statistics ──
  profileStats: async () => {
    const { data } = await apiClient.get<{
      servers: Array<{
        id: string;
        name: string;
        host: string | null;
        username: string | null;
        ip: string | null;
        hermes_version: string | null;
        components: Record<string, string>;
        is_local: boolean;
        online: boolean;
        profiles: Array<{
          id: number;
          server_id: string;
          host: string | null;
          profile_name: string;
          path: string | null;
          gateway_status: string | null;
          session_count: number;
          total_tokens: number;
          total_input_tokens: number;
          total_output_tokens: number;
          cache_hit_rate: number;
          model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
          provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
          daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
          current_config_version: number | null;
          latest_config_version: number | null;
          updated_at: number;
        }>;
      }>;
    }>('/profiles/aggregated');
    return data;
  },
  refreshProfileStats: async () => {
    const { data } = await apiClient.post<{
      servers: Array<{
        id: string;
        name: string;
        host: string | null;
        username: string | null;
        ip: string | null;
        hermes_version: string | null;
        components: Record<string, string>;
        is_local: boolean;
        online: boolean;
        profiles: Array<{
          id: number;
          server_id: string;
          host: string | null;
          profile_name: string;
          path: string | null;
          gateway_status: string | null;
          session_count: number;
          total_tokens: number;
          total_input_tokens: number;
          total_output_tokens: number;
          cache_hit_rate: number;
          model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
          provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
          daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
          current_config_version: number | null;
          latest_config_version: number | null;
          updated_at: number;
        }>;
      }>;
    }>('/profiles/aggregated/refresh');
    return data;
  },
  systemVersions: async () => {
    const { data } = await apiClient.get<Record<string, string>>('/system/versions');
    return data;
  },
};

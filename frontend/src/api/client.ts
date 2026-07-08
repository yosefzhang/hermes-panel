import axios from 'axios';
import type { LoginResponse, SectionsResponse, User } from '../types';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 15000,
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
  envPlain: async (profile: string) => {
    const { data } = await apiClient.get<Record<string, string>>('/env/plain', { params: { profile } });
    return data;
  },
  updateEnv: async (profile: string, key: string, value: string) => {
    const { data } = await apiClient.put<{ ok: boolean }>('/env', { value }, { params: { profile, key } });
    return data;
  },
  deleteEnv: async (profile: string, key: string) => {
    const { data } = await apiClient.delete<{ ok: boolean }>('/env', { params: { profile, key } });
    return data;
  },

  updateEnvBatch: async (profile: string, entries: Array<{ key: string; value: string | null }>) => {
    const { data } = await apiClient.put<{ updated: number }>('/env/batch', { entries }, { params: { profile } });
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
};

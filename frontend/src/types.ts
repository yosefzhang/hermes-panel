export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  role: Role;
  profiles: string[];
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export type JsonRecord = Record<string, unknown>;

export interface EnvEntry {
  key: string;
  value: string;
}

export interface SystemStats {
  cpu_percent: number;
  memory: { percent: number; total: number; used: number; available: number };
  disk: { percent: number; total: number; used: number; free: number };
  uptime_seconds: number;
}

export interface StatsHistoryEntry {
  timestamp: number;
  cpu_percent: number;
  memory_percent: number;
}

export interface TokenSummary {
  total_sessions: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_write: number;
  total_tokens: number;
  total_cost_usd: number;
  cache_hit_rate: number;
}

export interface TokenDailyEntry {
  day: string;
  total_tokens: number;
}

export interface TokenModelEntry {
  model: string;
  total_tokens: number;
  sessions: number;
}

export interface TokenProviderEntry {
  provider: string;
  total_tokens: number;
  sessions: number;
}

export interface TokenDashboardData {
  summary: TokenSummary;
  by_model: TokenModelEntry[];
  by_provider: TokenProviderEntry[];
  daily: TokenDailyEntry[];
}

export interface SkillRecord {
  name: string;
  path: string;
  category: string;
  description: string;
  enabled: boolean;
  source: string;
  trust?: string;
  status?: string;
  author?: string | null;
  origin?: string;
}

export interface PluginRecord {
  name: string;
  value: unknown;
  enabled: boolean;
}

export interface ProfileDetail {
  [key: string]: string;
}

export interface UsersResponse {
  users: User[];
}

export interface SkillsResponse {
  skills: SkillRecord[];
}

export interface PluginsResponse {
  plugins: Record<string, unknown>;
}

export interface ProfilesResponse {
  profiles: string[];
}

export interface SectionsResponse {
  sections: string[];
}

export interface ProfileFilesResponse {
  files: Array<{
    name: string;
    path: string;
    exists?: boolean;
    content: string;
  }>;
}

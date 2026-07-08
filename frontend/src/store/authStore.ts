import { create } from 'zustand';
import { api } from '../api/client';
import type { User } from '../types';

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  restore: () => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('hermes-panel-token'),
  user: null,
  loading: false,
  login: async (username, password) => {
    set({ loading: true });
    try {
      const response = await api.login(username, password);
      localStorage.setItem('hermes-panel-token', response.access_token);
      set({ token: response.access_token, user: response.user, loading: false });
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },
  restore: async () => {
    if (!get().token || get().user) {
      return;
    }
    set({ loading: true });
    try {
      const user = await api.me();
      set({ user, loading: false });
    } catch {
      localStorage.removeItem('hermes-panel-token');
      set({ token: null, user: null, loading: false });
    }
  },
  logout: () => {
    localStorage.removeItem('hermes-panel-token');
    set({ token: null, user: null });
  },
}));
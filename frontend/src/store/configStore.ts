import { create } from 'zustand';
import { api } from '../api/client';

export interface HostProfileGroup {
  id: string;
  name: string;
  isLocal: boolean;
  online: boolean;
  profiles: string[];
}

interface ConfigState {
  activeProfile: string;
  profiles: string[];
  hostProfiles: HostProfileGroup[];
  profileSections: Record<string, string[]>;
  setProfile: (profile: string) => void;
  loadProfiles: () => Promise<void>;
  loadHostProfiles: () => Promise<void>;
  loadSections: (profile: string) => Promise<string[]>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  activeProfile: localStorage.getItem('hermes-panel-profile') || 'default',
  profiles: ['default'],
  hostProfiles: [],
  profileSections: {},
  setProfile: (profile) => {
    localStorage.setItem('hermes-panel-profile', profile);
    set({ activeProfile: profile });
  },
  loadProfiles: async () => {
    const profiles = await api.profiles();
    const activeProfile = profiles.includes(get().activeProfile) ? get().activeProfile : profiles[0] || 'default';
    localStorage.setItem('hermes-panel-profile', activeProfile);
    set({ profiles, activeProfile });
  },
  loadHostProfiles: async () => {
    const data = await api.profileStats();
    const hostProfiles: HostProfileGroup[] = data.servers.map((server) => ({
      id: server.id,
      name: server.name,
      isLocal: server.is_local,
      online: server.online,
      profiles: server.profiles.map((p) => p.profile_name),
    }));
    set({ hostProfiles });
  },
  loadSections: async (profile) => {
    const cached = get().profileSections[profile];
    if (cached) {
      return cached;
    }
    const sections = await api.sections(profile);
    set((state) => ({
      profileSections: {
        ...state.profileSections,
        [profile]: sections,
      },
    }));
    return sections;
  },
}));
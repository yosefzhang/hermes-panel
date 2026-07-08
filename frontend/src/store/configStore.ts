import { create } from 'zustand';
import { api } from '../api/client';

interface ConfigState {
  activeProfile: string;
  profiles: string[];
  profileSections: Record<string, string[]>;
  setProfile: (profile: string) => void;
  loadProfiles: () => Promise<void>;
  loadSections: (profile: string) => Promise<string[]>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  activeProfile: localStorage.getItem('hermes-panel-profile') || 'default',
  profiles: ['default'],
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
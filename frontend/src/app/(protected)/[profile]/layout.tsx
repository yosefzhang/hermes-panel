'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useConfigStore } from '@/store/configStore';

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  const profile = useParams<{ profile: string }>()?.profile;
  const setProfile = useConfigStore((s) => s.setProfile);
  const loadProfiles = useConfigStore((s) => s.loadProfiles);

  useEffect(() => {
    if (!profile) return;
    // Only hit the API when the profile is unknown to the store; this avoids
    // re-fetching (and re-rendering the whole tree) on every sub-page switch
    // under /:profile/*, which caused a visible flash on each navigation.
    const { profiles } = useConfigStore.getState();
    if (!profiles.includes(profile)) {
      loadProfiles().then(() => {
        if (useConfigStore.getState().profiles.includes(profile)) {
          setProfile(profile);
        }
      });
    } else {
      setProfile(profile);
    }
  }, [profile, setProfile, loadProfiles]);

  return <>{children}</>;
}
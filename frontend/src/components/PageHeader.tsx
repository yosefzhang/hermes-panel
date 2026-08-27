import { useEffect } from 'react';
import { useHeaderExtra, useHeaderDescription } from './AppLayout';

interface Props {
  extra?: React.ReactNode;
  description?: string;
}

export default function PageHeader({ extra, description }: Props) {
  const setHeaderExtra = useHeaderExtra();
  const setHeaderDescription = useHeaderDescription();

  useEffect(() => {
    setHeaderExtra(extra ?? null);
    return () => setHeaderExtra(null);
  }, [setHeaderExtra, extra]);

  useEffect(() => {
    setHeaderDescription(description ?? null);
    return () => setHeaderDescription(null);
  }, [setHeaderDescription, description]);

  return null;
}
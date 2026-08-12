import { useEffect } from 'react';
import { useHeaderExtra } from './AppLayout';

interface Props {
  extra?: React.ReactNode;
}

export default function PageHeader({ extra }: Props) {
  const setHeaderExtra = useHeaderExtra();

  useEffect(() => {
    setHeaderExtra(extra ?? null);
    return () => setHeaderExtra(null);
  }, [setHeaderExtra, extra]);

  return null;
}

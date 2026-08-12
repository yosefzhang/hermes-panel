interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClass = {
  sm: 'h-4 w-4 border-b-2',
  md: 'h-8 w-8 border-b-2',
  lg: 'h-12 w-12 border-b-[3px]',
};

export default function Loading({ size = 'md', className = '' }: LoadingProps) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div
        className={`animate-spin rounded-full ${sizeClass[size]} border-primary`}
        aria-label="加载中"
        role="status"
      />
    </div>
  );
}

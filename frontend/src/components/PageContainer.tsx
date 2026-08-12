interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

export default function PageContainer({ children, className = '' }: PageContainerProps) {
  return <div className={`w-full px-6 space-y-6 ${className}`}>{children}</div>;
}

import { Inbox } from 'lucide-react';

interface Props {
  text?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export default function EmptyState({ text = '暂无数据', style, children }: Props) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted/50 p-10 text-center"
      style={style}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-card shadow-soft">
        <Inbox className="h-6 w-6 text-muted-foreground/70" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">{text}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

import { Input } from 'antd';

interface Props {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}

export default function JsonEditor({ value, onChange, rows = 18 }: Props) {
  return <Input.TextArea className="code-editor" value={value} rows={rows} onChange={(event) => onChange(event.target.value)} spellCheck={false} />;
}
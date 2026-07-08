import { Empty } from 'antd';

interface Props {
  text?: string;
  style?: React.CSSProperties;
}

const defaultStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '40px 0',
  color: '#999',
};

export default function EmptyState({ text = '暂无数据', style }: Props) {
  return (
    <div style={{ ...defaultStyle, ...style }}>
      <Empty description={text} image={Empty.PRESENTED_IMAGE_SIMPLE} />
    </div>
  );
}

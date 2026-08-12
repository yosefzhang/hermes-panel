import SectionPage from './SectionPage';

export default function MemoryConfig() {
  return (
    <SectionPage
      title="Memory"
      description="编辑 memory section 并查看记忆文件摘要"
      endpoint="/config/section/memory"
      showProfileName={true}
    />
  );
}

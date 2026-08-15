import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AlertCircle, ChevronDown, Search, Puzzle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';
import type { SkillRecord, SkillsResponse } from '../types';

// ── Origin 分类元数据 ─────────────────────────────
type OriginMeta = { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; hint: string };

const ORIGIN_META: Record<string, OriginMeta> = {
  agent_created: { label: 'Agent 创建', variant: 'default', hint: 'Hermes Agent 在本地为你自动创建的 skill' },
  agent_modified: { label: 'Agent 修改', variant: 'default', hint: 'Agent 修改过官方内置 skill（可用 hermes skills diff 查看）' },
  user: { label: '我创建', variant: 'default', hint: '你亲自撰写的 skill（frontmatter author=Yosef/Yosephine）' },
  community: { label: '社区/第三方', variant: 'secondary', hint: '来自 Skill Hub、外部目录或第三方作者' },
  official: { label: '官方内置', variant: 'outline', hint: '随 hermes-agent 发行的官方 skill，未被修改' },
  unknown: { label: '未分类', variant: 'secondary', hint: '无法识别来源' },
};

const ORIGIN_ORDER = ['agent_created', 'agent_modified', 'user', 'community', 'official', 'unknown'];

const ALL_KEY = '__all__';

function getOriginMeta(origin: string | undefined): OriginMeta {
  return ORIGIN_META[origin || 'unknown'] || ORIGIN_META.unknown;
}

// ── 右侧 SKILL.md 详情面板 ─────────────────────────
function SkillDetailPanel({ skill }: { skill: SkillRecord | null }) {
  const { activeProfile } = useConfigStore();
  const [detail, setDetail] = useState<{
    frontmatter: Record<string, string>;
    body: string;
    path: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!skill) { setDetail(null); return; }
    setLoading(true);
    try {
      const { data } = await apiClient.get<{
        frontmatter: Record<string, string>;
        body: string;
        path: string;
      }>(`/skills/${encodeURIComponent(skill.name)}`, { params: { profile: activeProfile } });
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [skill, activeProfile]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  if (!skill) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-center p-12 text-muted-foreground">
            选择一个 Skill 查看 SKILL.md 内容
          </div>
        </CardContent>
      </Card>
    );
  }

  const originMeta = getOriginMeta(skill.origin);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{skill.name}</CardTitle>
          <Badge variant={originMeta.variant} title={originMeta.hint}>
            {originMeta.label}
          </Badge>
          {skill.source && (
            <Badge variant="outline">{skill.source}</Badge>
          )}
          {skill.category && skill.category !== '未分类' && (
            <Badge variant="secondary">{skill.category}</Badge>
          )}
          <Badge variant={skill.enabled ? 'default' : 'outline'} className={skill.enabled ? '' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-transparent'}>
            {skill.enabled ? '已启用' : '未启用'}
          </Badge>
        </div>
      </CardHeader>
      <ScrollArea className="flex-1">
        <CardContent>
          {loading ? (
            <div className="text-center p-12 text-muted-foreground">加载中...</div>
          ) : detail ? (
            <>
              {detail.frontmatter?.author && (
                <p className="text-sm text-muted-foreground mb-4">
                  作者：{detail.frontmatter.author}
                </p>
              )}
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{detail.body || '*（该 SKILL.md 无正文内容）*'}</ReactMarkdown>
              </div>
              <p className="text-xs text-muted-foreground mt-6 break-all">
                路径: {detail.path}
              </p>
            </>
          ) : (
            <div className="text-center p-12 text-muted-foreground">
              无法读取该 Skill 的 SKILL.md 内容
            </div>
          )}
        </CardContent>
      </ScrollArea>
    </Card>
  );
}

// ── 左侧列表项 ─────────────────────────────────────
interface SkillListItemProps {
  skill: SkillRecord;
  selected: boolean;
  onSelect: (skill: SkillRecord) => void;
  onToggle: (name: string, enabled: boolean) => void;
  actionLoading: string | null;
}

function SkillListItem({
  skill, selected, onSelect, onToggle, actionLoading,
}: SkillListItemProps) {
  return (
    <div
      onClick={() => onSelect(skill)}
      className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors ${
        selected
          ? 'bg-primary/10 border border-primary/20'
          : 'hover:bg-accent border border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0 w-full max-w-full">
        <p className="text-sm font-medium truncate">{skill.name}</p>
        {skill.description && (
          <p className="text-xs leading-5 text-muted-foreground whitespace-normal break-words max-w-full">
            {skill.description}
          </p>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={skill.enabled}
          disabled={actionLoading === `toggle:${skill.name}`}
          onCheckedChange={(checked) => onToggle(skill.name, checked)}
        />
      </div>
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────
export default function SkillsManager() {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();

  const [search, setSearch] = useState('');
  const [activeOrigin, setActiveOrigin] = useState<string>(ALL_KEY);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchSkills = useCallback(
    (force?: boolean) =>
      apiClient
        .get<SkillsResponse>('/skills', {
          params: { profile: activeProfile },
          ...(force ? { refresh: true } : {}),
        })
        .then((res) => res.data.skills),
    [activeProfile],
  );

  const { data: skills, loading, error, execute: reload } = useApi(fetchSkills, [activeProfile]);

  // 计算每个 origin 的数量
  const originCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of skills ?? []) {
      const key = s.origin || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [skills]);

  // 出现过的 origin（按预设顺序）
  const availableOrigins = useMemo(() => {
    return ORIGIN_ORDER.filter((o) => originCounts[o] > 0);
  }, [originCounts]);

  // 搜索 + origin 过滤
  const filtered = useMemo(() => {
    let list = skills ?? [];
    if (activeOrigin !== ALL_KEY) {
      list = list.filter((s) => (s.origin || 'unknown') === activeOrigin);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          (s.author ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [skills, search, activeOrigin]);

  // 按 category 分组
  const grouped = useMemo(() => {
    const groups: Record<string, SkillRecord[]> = {};
    for (const s of filtered) {
      const cat = s.category || '未分类';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === '未分类') return 1;
      if (b === '未分类') return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const handleToggle = async (name: string, enabled: boolean) => {
    setActionLoading(`toggle:${name}`);
    try {
      await apiClient.post(`/skills/${name}/toggle`, { enabled }, { params: { profile: activeProfile } });
      toast({
        title: '成功',
        description: enabled ? '已启用' : '已停用',
      });
      reload(true);
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '操作失败',
      });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        extra={
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索 Skill 名称、描述或分类..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-[320px]"
            />
          </div>
        }
      />

      {/* Error message */}
      {error && <ErrorAlert message={error} />}

      {/* Origin tabs */}
      <div className="flex gap-2 border-b">
        <button
          onClick={() => setActiveOrigin(ALL_KEY)}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeOrigin === ALL_KEY
              ? 'tab-active'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
          }`}
        >
          全部
        </button>
        {availableOrigins.map((origin) => {
          const meta = ORIGIN_META[origin];
          return (
            <button
              key={origin}
              onClick={() => setActiveOrigin(origin)}
              title={meta.hint}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeOrigin === origin
                  ? 'tab-active'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
              }`}
            >
              {meta.label} ({originCounts[origin]})
            </button>
          );
        })}
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-12 gap-4 h-[calc(100vh-280px)] min-h-[360px]">
        {/* Left: Skills list */}
        <Card className="col-span-5 flex flex-col">
          <CardHeader>
            <CardTitle>{filtered.length} 个 Skill</CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1">
            <CardContent>
              {loading ? (
                <Loading className="py-12" />
              ) : grouped.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  {search || activeOrigin !== ALL_KEY ? '没有匹配的 Skill' : '暂无 Skill'}
                </div>
              ) : (
                <div className="space-y-2">
                  {grouped.map(([category, items]) => (
                    <Collapsible key={category} defaultOpen>
                      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 text-left hover:bg-accent rounded-md">
                        <ChevronDown className="h-4 w-4 transition-transform data-[state=open]:rotate-0 data-[state=closed]:-rotate-90" />
                        <span className="text-xs font-semibold uppercase tracking-wide">
                          {category}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {items.length}
                        </Badge>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="space-y-1 mt-1">
                          {items.map((skill) => (
                            <SkillListItem
                              key={skill.path || `${skill.source}:${skill.name}`}
                              skill={skill}
                              selected={selectedSkill?.name === skill.name}
                              onSelect={setSelectedSkill}
                              onToggle={handleToggle}
                              actionLoading={actionLoading}
                            />
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              )}
            </CardContent>
          </ScrollArea>
        </Card>

        {/* Right: Detail panel */}
        <div className="col-span-7">
          <SkillDetailPanel skill={selectedSkill} />
        </div>
      </div>
    </PageContainer>
  );
}

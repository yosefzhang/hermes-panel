import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Card, Col, Collapse, Input, Row, Space,
  Switch, Tabs, Tag, Typography, App as AntApp, Tooltip,
} from 'antd';
import ReactMarkdown from 'react-markdown';
import PageHeader from '../components/PageHeader';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import type { SkillRecord, SkillsResponse } from '../types';

const { Text } = Typography;

// ── Origin 分类元数据 ─────────────────────────────
// origin 是"作者身份 × source"派生出来的语义标签，比原始 source 更贴近用户视角
type OriginMeta = { label: string; color: string; hint: string };

const ORIGIN_META: Record<string, OriginMeta> = {
  agent_created: { label: 'Agent 创建', color: 'geekblue', hint: 'Hermes Agent 在本地为你自动创建的 skill' },
  agent_modified: { label: 'Agent 修改', color: 'gold', hint: 'Agent 修改过官方内置 skill（可用 hermes skills diff 查看）' },
  user: { label: '我创建', color: 'green', hint: '你亲自撰写的 skill（frontmatter author=Yosef/Yosephine）' },
  community: { label: '社区/第三方', color: 'magenta', hint: '来自 Skill Hub、外部目录或第三方作者' },
  official: { label: '官方内置', color: 'blue', hint: '随 hermes-agent 发行的官方 skill，未被修改' },
  unknown: { label: '未分类', color: 'default', hint: '无法识别来源' },
};

const ORIGIN_ORDER = ['agent_created', 'agent_modified', 'user', 'community', 'official', 'unknown'];

// ── Source 颜色映射（作为附加信息保留） ────────────
const SOURCE_COLORS: Record<string, string> = {
  builtin: 'blue',
  hub: 'purple',
  local: 'green',
  external: 'orange',
  modified: 'gold',
  'skills.sh': 'magenta',
};

const ALL_KEY = '__all__';

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] || 'default';
}

function getOriginMeta(origin: string | undefined): OriginMeta {
  return ORIGIN_META[origin || 'unknown'] || ORIGIN_META.unknown;
}

// ── Origin Tag（主分类，语义化标签） ───────────────

function OriginTag({ origin }: { origin: string | undefined }) {
  const meta = getOriginMeta(origin);
  return (
    <Tooltip title={meta.hint}>
      <Tag color={meta.color} style={{ margin: 0 }}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

// ── Source Tag（保留作为技术侧信息） ───────────────

function SourceTag({ source }: { source: string }) {
  if (!source) return null;
  return <Tag color={sourceColor(source)}>{source}</Tag>;
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
      <Card style={{ height: '100%' }} styles={{ body: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' } }}>
        <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
          选择一个 Skill 查看 SKILL.md 内容
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space wrap>
          <Text strong>{skill.name}</Text>
          <OriginTag origin={skill.origin} />
          <SourceTag source={skill.source} />
          {skill.category && skill.category !== '未分类' && (
            <Tag color="cyan">{skill.category}</Tag>
          )}
          {skill.enabled ? (
            <Tag color="success">已启用</Tag>
          ) : (
            <Tag color="error">已停用</Tag>
          )}
        </Space>
      }
      style={{ height: '100%' }}
      styles={{ body: { height: 'calc(100% - 58px)', overflow: 'auto' } }}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中...</div>
      ) : detail ? (
        <>
          {detail.frontmatter?.author && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              作者：{detail.frontmatter.author}
            </Text>
          )}
          <div className="markdown-body" style={{ fontSize: 13, lineHeight: 1.7 }}>
            <ReactMarkdown>{detail.body || '*（该 SKILL.md 无正文内容）*'}</ReactMarkdown>
          </div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 16, wordBreak: 'break-all' }}>
            路径: {detail.path}
          </Text>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          无法读取该 Skill 的 SKILL.md 内容
        </div>
      )}
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: selected ? '#e6f4ff' : 'transparent',
        border: selected ? '1px solid #91caff' : '1px solid transparent',
        transition: 'all 0.2s',
      }}
      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = '#fafafa'; }}
      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong ellipsis={{ tooltip: skill.name }} style={{ fontSize: 13 }}>
          {skill.name}
        </Text>
        {skill.description && (
          <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 11, lineHeight: 1.4 }}>
            {skill.description}
          </Text>
        )}
      </div>
      <Space size={2} onClick={(e) => e.stopPropagation()}>
        <Switch
          size="small"
          checked={skill.enabled}
          loading={actionLoading === `toggle:${skill.name}`}
          onChange={(checked) => onToggle(skill.name, checked)}
        />
      </Space>
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────

export default function SkillsManager() {
  const { message } = AntApp.useApp();
  const { activeProfile } = useConfigStore();

  const [search, setSearch] = useState('');
  const [activeOrigin, setActiveOrigin] = useState<string>(ALL_KEY);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const panesWrapRef = useRef<HTMLDivElement | null>(null);
  const [panesHeight, setPanesHeight] = useState<number>(560);

  const fetchSkills = useCallback(
    () => apiClient.get<SkillsResponse>('/skills', { params: { profile: activeProfile } }).then((res) => res.data.skills),
    [activeProfile],
  );

  const { data: skills, loading, error, execute: reload } = useApi(fetchSkills, [activeProfile]);

  // 计算每个 origin 的数量（用于 Tab 上的角标）
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
      message.success(enabled ? '已启用' : '已停用');
      reload();
    } catch {
      message.error('操作失败');
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    const updatePanesHeight = () => {
      const el = panesWrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const next = Math.max(360, Math.floor(window.innerHeight - top - 12));
      setPanesHeight(next);
    };
    updatePanesHeight();
    window.addEventListener('resize', updatePanesHeight);
    return () => window.removeEventListener('resize', updatePanesHeight);
  }, []);

  const tabItems = useMemo(() => {
    const items: { key: string; label: React.ReactNode }[] = [
      { key: ALL_KEY, label: <span>全部</span> },
    ];
    for (const origin of availableOrigins) {
      const meta = ORIGIN_META[origin];
      items.push({
        key: origin,
        label: (
          <Tooltip title={meta.hint}>
            <span>{meta.label}</span>
          </Tooltip>
        ),
      });
    }
    return items;
  }, [availableOrigins]);

  return (
    <>
      <PageHeader
        title="Skills"
        profile={activeProfile}
        profileName="通过 hermes skills list 管理技能"
        extra={
          <Input
            placeholder="搜索 Skill 名称、描述或分类..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ width: 320 }}
          />
        }
      />

      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}

      {/* 横向 source 导航栏 */}
      <Tabs
        activeKey={activeOrigin}
        onChange={setActiveOrigin}
        type="card"
        items={tabItems}
        style={{ marginBottom: 16 }}
      />

      {/* 左右两栏 */}
      <div ref={panesWrapRef} style={{ height: `${panesHeight}px` }}>
        <Row gutter={16} style={{ height: '100%' }}>
          <Col span={7} style={{ height: '100%' }}>
            <Card
              size="small"
              title={`${filtered.length} 个 Skill`}
              loading={loading}
              style={{ height: '100%' }}
              styles={{ body: { padding: 8, height: 'calc(100% - 46px)', overflow: 'auto' } }}
            >
              {grouped.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 32, color: '#999' }}>
                  {search || activeOrigin !== ALL_KEY ? '没有匹配的 Skill' : '暂无 Skill'}
                </div>
              ) : (
                <Collapse
                  ghost
                  defaultActiveKey={grouped.map(([cat]) => cat)}
                  style={{ background: 'transparent' }}
                  items={grouped.map(([category, items]) => ({
                    key: category,
                    label: (
                      <Space>
                        <Text strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                          {category}
                        </Text>
                        <Tag style={{ fontSize: 10, lineHeight: '16px' }}>{items.length}</Tag>
                      </Space>
                    ),
                    children: (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                    ),
                    style: { borderBottom: 'none' },
                  }))}
                />
              )}
            </Card>
          </Col>

          <Col span={17} style={{ height: '100%' }}>
            <SkillDetailPanel skill={selectedSkill} />
          </Col>
        </Row>
      </div>
    </>
  );
}

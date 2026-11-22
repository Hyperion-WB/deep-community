import React, { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw, Search, Save, Loader2, CheckCircle2, UserRound, Sparkles, Upload } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { CustomDropdown } from './CustomDropdown';

/** 内置厂商（与后端 ai_service.AI_VENDORS 对应），选「自定义」可自由填 base_url */
const VENDOR_PRESETS = [
  { value: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1' },
  { value: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
  { value: 'dashscope', label: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'moonshot', label: 'Moonshot', base: 'https://api.moonshot.cn/v1' },
  { value: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1' },
  { value: 'gemini', label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { value: 'ark', label: '火山方舟 · 豆包', base: 'https://ark.cn-beijing.volces.com/api/v3' },
  { value: 'qianfan', label: '百度千帆 · 文心', base: 'https://qianfan.baidubce.com/v2' },
  { value: 'hunyuan', label: '腾讯混元', base: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { value: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
  { value: 'ollama', label: 'Ollama（本地）', base: 'http://localhost:11434/v1' },
  { value: 'custom', label: '自定义', base: '' },
];

type Emotion = { key: string; label: string; icon: string; hint: string; examples: string[] };
const EMOTION_FALLBACK: Emotion[] = [
  { key: 'humor', label: '梗王', icon: '😂', hint: '一句极客梗收尾', examples: [] },
  { key: 'normal', label: '冷面观察员', icon: '😐', hint: '零情绪、只陈述事实', examples: [] },
  { key: 'warm', label: '温柔前辈', icon: '🫶', hint: '共情 + 具体鼓励', examples: [] },
  { key: 'sharp', label: '毒舌评审', icon: '🔪', hint: '挑毛病 + 给解法', examples: [] },
  { key: 'hype', label: '捧场王', icon: '🎉', hint: '夸张夸奖 + 感叹号', examples: [] },
  { key: 'nerd', label: '考据党', icon: '🔍', hint: '必提一个技术细节', examples: [] },
  { key: 'poet', label: '文艺比喻', icon: '🌙', hint: '生活化比喻收尾', examples: [] },
  { key: 'curious', label: '好奇宝宝', icon: '❓', hint: '以具体问题结尾', examples: [] },
];

export const AIAdminPanel: React.FC = () => {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sample, setSample] = useState('');
  const [emotions, setEmotions] = useState<Emotion[]>(EMOTION_FALLBACK);
  const [cardInfo, setCardInfo] = useState<any>(null);
  const [uploadingCard, setUploadingCard] = useState(false);
  const [digestPreview, setDigestPreview] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [cfg, setCfg] = useState({
    ai_vendor: 'openai',
    ai_base_url: 'https://api.openai.com/v1',
    ai_model: '',
    ai_user_name: 'AI 小助手',
    ai_user_avatar: '',
    ai_style: 'humor',
    ai_enabled: '0',
    ai_auto_comment: '1',
    ai_daily_limit: '50',
    ai_reply_buffer_sec: '20',
    ai_disable_thinking: '0',
    ai_persona_name: '',
    ai_persona_desc: '',
    ai_persona_card: '',
    ai_catchphrase: '',
    ai_reply_mode: 'hybrid',
    ai_reply_phrases: '',
    ai_emotion_intensity: '50',
    ai_mood_enabled: '1',
    ai_fun_enabled: '1',
    ai_api_key_masked: '',
    ai_api_key_set: false,
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/admin/ai/config');
      setCfg((prev) => ({ ...prev, ...(res.data?.config || {}) }));
      if (res.data?.emotions?.length) setEmotions(res.data.emotions);
      apiClient.get('/admin/ai/digest-preview')
        .then((r) => setDigestPreview(
          r.data?.mood ? `今日心情：${r.data.mood}｜今日已回复 ${r.data.count} 条` : ''
        ))
        .catch(() => undefined);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '读取 AI 配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    return q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  }, [models, modelQuery]);

  const handleVendorChange = (v: string) => {
    const preset = VENDOR_PRESETS.find((p) => p.value === v);
    setCfg((prev) => ({
      ...prev,
      ai_vendor: v,
      ai_base_url: preset?.base ? preset.base : prev.ai_base_url,
    }));
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    try {
      const res = await apiClient.post('/admin/ai/models', {
        base_url: cfg.ai_base_url,
        api_key: apiKeyInput.trim() || undefined,
      });
      const list: string[] = res.data?.models || [];
      setModels(list);
      toast.success(`拉取到 ${list.length} 个模型`);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '拉取模型失败');
    } finally {
      setFetchingModels(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setUploadingAvatar(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/posts/upload-image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const url = res.data?.url;
      if (url) {
        setCfg((prev) => ({ ...prev, ai_user_avatar: url }));
        toast.success('头像已上传，记得点保存配置');
      } else {
        toast.error('上传返回异常');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const uploadPersonaCard = async (file: File) => {
    setUploadingCard(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/admin/ai/persona-card', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const card = res.data?.card || {};
      setCardInfo(card);
      setCfg((prev) => ({
        ...prev,
        ai_persona_card: res.data?.raw || '',
        ai_persona_name: card.name || prev.ai_persona_name,
        ai_persona_desc: [card.description, card.personality].filter(Boolean).join('\n').slice(0, 800) || prev.ai_persona_desc,
      }));
      toast.success(`已载入角色卡「${card.name || '未命名'}」`);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '角色卡解析失败');
    } finally {
      setUploadingCard(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = { ...cfg };
      delete payload.ai_api_key_masked;
      delete payload.ai_api_key_set;
      if (apiKeyInput.trim()) payload.ai_api_key = apiKeyInput.trim();
      const res = await apiClient.put('/admin/ai/config', payload);
      setCfg((prev) => ({ ...prev, ...(res.data?.config || {}) }));
      setApiKeyInput('');
      toast.success('AI 配置已保存（已持久化到服务端）');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setSample('');
    try {
      const res = await apiClient.post('/admin/ai/test');
      setSample(res.data?.sample || '');
      toast.success('调用成功');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '调用失败');
    } finally {
      setTesting(false);
    }
  };

  const inputCls = 'w-full h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong';
  const labelCls = 'block text-2xs font-semibold text-wb-text-secondary mb-1';

  if (loading) {
    return <div className="py-16 text-center text-xs text-wb-text-muted font-mono">AI 配置加载中…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-1">
        <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-2">
          <Bot className="w-4 h-4" /> AI 管理
          <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-danger/10 text-wb-danger font-semibold">仅超级管理员</span>
        </h3>
        <p className="text-3xs text-wb-text-muted leading-relaxed">
          AI 以真实用户身份出现在每篇帖子评论区，根据正文自动生成一条评论（每日日报除外）。
          配置持久化在服务端，重启或跨天不会丢失。
        </p>
      </div>

      {/* 人格与情感 */}
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h4 className="text-2xs font-bold text-wb-text-primary">人格与情感</h4>
          <span className="text-3xs text-wb-text-muted font-mono">8 种可明显区分的说话方式</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>人格名称</label>
            <input value={cfg.ai_persona_name} onChange={(e) => setCfg({ ...cfg, ai_persona_name: e.target.value })}
              placeholder="如 大肥鱼 / 夜班运维老哥" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>口头禅（按概率出现在句尾）</label>
            <input value={cfg.ai_catchphrase} onChange={(e) => setCfg({ ...cfg, ai_catchphrase: e.target.value.slice(0, 30) })}
              placeholder="如 ——来自摸鱼办" className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>性格 / 人设描述</label>
          <textarea value={cfg.ai_persona_desc} onChange={(e) => setCfg({ ...cfg, ai_persona_desc: e.target.value })}
            rows={3} placeholder="例：嘴很碎但心很软，爱用运维梗，讨厌空话，看到认真写复盘的人会格外温柔。"
            className="w-full p-2.5 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong resize-y" />
        </div>

        <div className="p-3 rounded-xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="wb-pressable h-8 px-3 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:text-wb-text-primary">
              {uploadingCard ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              上传性格卡（JSON）
              <input type="file" accept=".json,application/json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPersonaCard(f); e.currentTarget.value = ''; }} />
            </label>
            {cfg.ai_persona_card && (
              <button type="button" onClick={() => { setCfg({ ...cfg, ai_persona_card: '' }); setCardInfo(null); }}
                className="h-8 px-3 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-muted hover:text-wb-danger">
                移除角色卡
              </button>
            )}
          </div>
          {cardInfo && (
            <p className="text-3xs text-wb-success">
              已载入 {cardInfo.spec} · {cardInfo.name}{cardInfo.tags?.length ? ` · 标签：${cardInfo.tags.slice(0, 4).join(' / ')}` : ''}
            </p>
          )}
          <p className="text-3xs text-wb-text-muted leading-relaxed">
            兼容开源 <span className="font-mono">SillyTavern / TavernAI Character Card V1 & V2</span> 的 JSON 格式
            （name / description / personality / scenario / mes_example / system_prompt）。仅采用其数据格式，不引入任何外部代码。
          </p>
        </div>

        <div className="space-y-1.5">
          <label className={labelCls}>情感预设（并行选择）</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {emotions.map((em) => {
              const on = cfg.ai_style === em.key;
              return (
                <button key={em.key} type="button" onClick={() => setCfg({ ...cfg, ai_style: em.key })}
                  aria-pressed={on}
                  title={em.hint}
                  className={`wb-pressable p-2 rounded-xl border text-left transition-colors ${
                    on ? 'bg-wb-text-primary text-wb-bg-page border-transparent' : 'bg-wb-bg-subtle/50 border-wb-border-subtle hover:bg-wb-bg-subtle'
                  }`}>
                  <span className="text-sm leading-none">{em.icon}</span>
                  <span className="block mt-1 text-2xs font-semibold">{em.label}</span>
                  <span className={`block text-3xs leading-snug mt-0.5 ${on ? 'opacity-75' : 'text-wb-text-muted'}`}>{em.hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className={labelCls}>情绪强度</label>
            <span className="text-2xs font-mono text-wb-text-primary">{cfg.ai_emotion_intensity}</span>
          </div>
          <input type="range" min={0} max={100} step={5} value={cfg.ai_emotion_intensity}
            onChange={(e) => setCfg({ ...cfg, ai_emotion_intensity: e.target.value })}
            className="wb-range w-full" />
          <p className="text-3xs text-wb-text-muted">影响句长上限、感叹号与 emoji 用量：越低越克制，越高越外放。</p>
        </div>
      </div>

      {/* 回复语设置 */}
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-3">
        <h4 className="text-2xs font-bold text-wb-text-primary">回复语</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {([
            ['ai', '只用模型生成'],
            ['hybrid', '模型优先 · 失败用回复语兜底'],
            ['fixed', '只用固定回复语（不调模型）'],
          ] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setCfg({ ...cfg, ai_reply_mode: k })}
              className={`wb-pressable h-8 px-3 rounded-capsule border text-2xs transition-colors ${
                cfg.ai_reply_mode === k ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-semibold' : 'bg-wb-bg-surface border-wb-border-subtle text-wb-text-secondary'
              }`}>{label}</button>
          ))}
        </div>
        <textarea value={cfg.ai_reply_phrases} onChange={(e) => setCfg({ ...cfg, ai_reply_phrases: e.target.value })}
          rows={4} placeholder="一行一条，AI 会随机挑一条；例如：看完顺手给缓存续了杯咖啡。" 
          className="w-full p-2.5 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong resize-y" />
        <p className="text-3xs text-wb-text-muted leading-relaxed">
          固定模式不调用模型，限流 / 无 Key 也能照常回复；混合模式在模型失败时自动兜底，保证「自动去回复」不中断。
        </p>
      </div>

      {/* 厂商与模型 */}
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-3">
        <h4 className="text-2xs font-bold text-wb-text-primary">模型接入</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>厂商</label>
            <CustomDropdown
              value={cfg.ai_vendor}
              onChange={(v) => handleVendorChange(String(v))}
              options={VENDOR_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              size="sm"
            />
          </div>
          <div>
            <label className={labelCls}>接口地址 Base URL</label>
            <input value={cfg.ai_base_url} onChange={(e) => setCfg({ ...cfg, ai_base_url: e.target.value })}
              placeholder="https://api.openai.com/v1" className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={cfg.ai_api_key_set ? `已保存：${cfg.ai_api_key_masked}（留空则不修改）` : 'sk-...'}
              className={inputCls}
            />
            <button type="button" onClick={() => void fetchModels()} disabled={fetchingModels}
              className="wb-pressable shrink-0 h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
              {fetchingModels ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              拉取模型
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>
              模型名称 {models.length > 0 && <span className="text-wb-text-muted">（已拉取 {models.length} 个）</span>}
            </label>
            <p className="mb-1 text-3xs text-wb-warn leading-relaxed">
              请不要用 <code className="font-mono">openrouter/free</code> 这类「路由模型」：它每次都随机路由到
              一个免费小模型，常见 content 为空、429 限流和跑题英文。建议填具体模型，
              如 <code className="font-mono">deepseek/deepseek-chat</code>、
              <code className="font-mono">google/gemini-2.0-flash-001</code>、
              <code className="font-mono">deepseek-chat</code>（DeepSeek 官方）。
            </p>
            {models.length > 0 ? (
              <>
                <div className="relative mb-1.5">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-wb-text-muted pointer-events-none" />
                  <input value={modelQuery} onChange={(e) => setModelQuery(e.target.value)}
                    placeholder="搜索模型…" className={inputCls + ' pl-7'} />
                </div>
                <div className="max-h-40 overflow-y-auto rounded-xl border border-wb-border-subtle divide-y divide-wb-border-subtle/60">
                  {filteredModels.length === 0 && <p className="p-3 text-3xs text-wb-text-muted text-center">无匹配模型</p>}
                  {filteredModels.map((m) => (
                    <button key={m} type="button" onClick={() => setCfg({ ...cfg, ai_model: m })}
                      className={`w-full text-left px-2.5 py-1.5 text-2xs transition-colors ${cfg.ai_model === m ? 'bg-wb-brand/15 text-wb-brand font-semibold' : 'hover:bg-wb-bg-subtle'}`}>
                      {m}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <input value={cfg.ai_model} onChange={(e) => setCfg({ ...cfg, ai_model: e.target.value })}
                placeholder="如 gpt-4o-mini / deepseek-chat" className={inputCls} />
            )}
          </div>
          <div>
            <label className={labelCls + ' mt-3'}>每日补评价额度</label>
            <input value={cfg.ai_daily_limit} onChange={(e) => setCfg({ ...cfg, ai_daily_limit: e.target.value.replace(/[^\d]/g, '') })}
              className={inputCls} />
            <label className={labelCls + ' mt-3'}>回复间缓冲（秒）</label>
            <input value={cfg.ai_reply_buffer_sec} onChange={(e) => setCfg({ ...cfg, ai_reply_buffer_sec: e.target.value.replace(/[^\d]/g, '') })}
              className={inputCls} />
            <p className="text-3xs text-wb-text-muted">相邻两条 AI 回复的最小间隔，防止高频调用返回空结果。</p>
            <p className="text-3xs text-wb-text-muted leading-relaxed">
新帖发布后会立即回复；此额度为「基础额度」，实际每日上限取 2 倍且不低于 100（防刷屏硬熔断）。
            </p>
          </div>
        </div>
      </div>

      {/* AI 用户形象 */}
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-3">
        <h4 className="text-2xs font-bold text-wb-text-primary flex items-center gap-1.5">
          <UserRound className="w-3.5 h-3.5" /> AI 用户形象
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>名称（评论区显示）</label>
            <input value={cfg.ai_user_name} onChange={(e) => setCfg({ ...cfg, ai_user_name: e.target.value })}
              placeholder="AI 小助手" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>头像</label>
            {digestPreview && (
        <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle text-3xs text-wb-text-secondary">
          {digestPreview} · 每晚 20:00 会自动向超级管理员推送当天回复了多少条帖子。
        </div>
      )}

      <div className="flex items-center gap-2">
              <label className="wb-pressable h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:text-wb-text-primary">
                {uploadingAvatar ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {uploadingAvatar ? '上传中…' : '上传头像'}
                <input type="file" accept="image/*" className="hidden" disabled={uploadingAvatar}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.currentTarget.value = ''; }} />
              </label>
              {cfg.ai_user_avatar && (
                <button type="button" onClick={() => setCfg({ ...cfg, ai_user_avatar: '' })}
                  className="h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-muted hover:text-wb-danger">
                  移除
                </button>
              )}
            </div>
            <p className="mt-1 text-3xs text-wb-text-muted">直接选择本地图片上传，无需填写地址</p>
          </div>
        </div>
        {cfg.ai_user_avatar && (
          <div className="flex items-center gap-2">
            <img src={cfg.ai_user_avatar} alt="AI 头像预览" className="w-10 h-10 rounded-full object-cover border border-wb-border-subtle" />
            <span className="text-3xs text-wb-text-muted">头像预览</span>
          </div>
        )}
      </div>

      {/* 开关 */}
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-2">
        {[
          { key: 'ai_enabled', label: '启用 AI 用户', desc: '关闭后 AI 不出现在评论区' },
          { key: 'ai_auto_comment', label: '自动生成评论', desc: '每 5 分钟随机挑一篇未评论过的帖子补一条（排除日报/早报/周报）' },
          { key: 'ai_disable_thinking', label: '关闭模型思考过程', desc: '省 token、避免正文为空；仅部分厂商支持（硅基流动/通义等）' },
          { key: 'ai_mood_enabled', label: '每日心情', desc: '每天自动换一种心情底色；星期四自动切成「疯狂星期四限定」' },
          { key: 'ai_fun_enabled', label: '趣味口癖', desc: '口头禅按概率出现在句尾，不会每句都加' },
        ].map((it) => {
          const on = (cfg as any)[it.key] === '1';
          return (
            <div key={it.key} className="flex items-center justify-between gap-3 py-1.5">
              <div>
                <p className="text-2xs font-semibold text-wb-text-primary">{it.label}</p>
                <p className="text-3xs text-wb-text-muted">{it.desc}</p>
              </div>
              <button type="button" onClick={() => setCfg({ ...cfg, [it.key]: on ? '0' : '1' })}
                className={`wb-pressable relative w-11 h-6 rounded-capsule border transition-colors shrink-0 ${on ? 'bg-wb-text-primary border-wb-text-primary' : 'bg-wb-bg-subtle border-wb-border-subtle'}`}>
                <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full transition-all ${on ? 'left-[22px] bg-wb-bg-page' : 'left-0.5 bg-wb-text-muted'}`}
                  style={{ width: 18, height: 18 }} />
              </button>
            </div>
          );
        })}
      </div>

      {sample && (
        <div className="p-3 rounded-2xl bg-wb-success/10 border border-wb-success/30 text-2xs text-wb-text-primary">
          <p className="font-semibold mb-1 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> 模型试生成</p>
          <p className="leading-relaxed">{sample}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={saving}
          className="wb-pressable h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 保存配置
        </button>
        <button type="button" onClick={() => void test()} disabled={testing}
          className="wb-pressable h-9 px-4 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} 测试调用
        </button>
      </div>
    </div>
  );
};

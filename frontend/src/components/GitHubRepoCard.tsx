import React, { useEffect, useState } from 'react';
import { Star, GitFork, ExternalLink, Scale } from 'lucide-react';

interface GitHubRepoData {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  license: { name: string; spdx_id?: string } | null;
  owner: {
    login: string;
    avatar_url: string;
  };
}

const LANGUAGE_COLORS: Record<string, string> = {
  Rust: '#dea584',
  Go: '#00add8',
  Python: '#3572A5',
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  C: '#555555',
  'C++': '#f34b7d',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  Vue: '#41b883',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  Dockerfile: '#384d54',
};

// 内存级 LRU 缓存，防止频繁渲染触发 GitHub API 速率限制 (60次/小时)
const repoCache = new Map<string, GitHubRepoData>();

export const parseGitHubRepo = (url: string): { owner: string; repo: string } | null => {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('github.com')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, '');
      const reserved = ['features', 'pricing', 'login', 'join', 'explore', 'topics', 'trending', 'collections', 'events', 'sponsors', 'about', 'contact'];
      if (!reserved.includes(owner.toLowerCase())) {
        return { owner, repo };
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const GitHubRepoCard: React.FC<{ url: string; inline?: boolean }> = ({ url, inline = false }) => {
  const repoInfo = parseGitHubRepo(url);
  const [data, setData] = useState<GitHubRepoData | null>(() => {
    if (!repoInfo) return null;
    return repoCache.get(`${repoInfo.owner}/${repoInfo.repo}`) || null;
  });
  const [loading, setLoading] = useState<boolean>(!data);

  useEffect(() => {
    if (!repoInfo) return;
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    if (repoCache.has(key)) {
      setData(repoCache.get(key)!);
      setLoading(false);
      return;
    }

    let isMounted = true;
    fetch(`https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Repo fetch failed');
        return res.json();
      })
      .then((json: GitHubRepoData) => {
        if (isMounted) {
          repoCache.set(key, json);
          setData(json);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          // 降级兜底数据
          const fallback: GitHubRepoData = {
            name: repoInfo.repo,
            full_name: `${repoInfo.owner}/${repoInfo.repo}`,
            description: '查看 GitHub 官方仓库源码与最新进展',
            html_url: url,
            stargazers_count: 0,
            forks_count: 0,
            language: null,
            license: null,
            owner: {
              login: repoInfo.owner,
              avatar_url: `https://github.com/${repoInfo.owner}.png?size=64`,
            },
          };
          setData(fallback);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [url]);

  if (!repoInfo) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-wb-text-primary underline">
        {url}
      </a>
    );
  }

  // 行内简明模式 (如正文句子中嵌入的小胶囊)
  if (inline) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 mx-1 rounded-md bg-wb-bg-subtle hover:bg-wb-border-subtle border border-wb-border-subtle text-xs font-mono text-wb-text-primary transition-all group"
      >
        <svg className="w-3.5 h-3.5 fill-current shrink-0" viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
        <span className="font-semibold group-hover:underline">{repoInfo.owner}/{repoInfo.repo}</span>
        {data && data.stargazers_count > 0 && (
          <span className="text-3xs text-wb-text-muted flex items-center gap-0.5">
            <Star className="w-2.5 h-2.5 fill-wb-warn text-wb-warn" />
            {data.stargazers_count >= 1000 ? `${(data.stargazers_count / 1000).toFixed(1)}k` : data.stargazers_count}
          </span>
        )}
      </a>
    );
  }

  const formatCount = (count: number) => {
    if (count >= 100000) return `${(count / 1000).toFixed(0)}k`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return String(count);
  };

  const langColor = data?.language ? LANGUAGE_COLORS[data.language] || '#8b949e' : null;

  return (
    <div className="my-5 p-4 sm:p-5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all select-none not-prose">
      {/* 顶部标题与快速跳转 */}
      <div className="flex items-center justify-between gap-3 border-b border-wb-border-subtle pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {data?.owner.avatar_url ? (
            <img loading="lazy" decoding="async"
              src={data.owner.avatar_url}
              alt=""
              className="w-7 h-7 rounded-lg border border-wb-border-subtle bg-white shrink-0"
            />
          ) : (
            <div className="w-7 h-7 rounded-lg bg-wb-text-primary text-wb-bg-page flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </div>
          )}
          <div className="min-w-0">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm sm:text-base font-bold text-wb-text-primary hover:underline flex items-center gap-1.5 truncate"
            >
              <span>{repoInfo.owner}</span>
              <span className="text-wb-text-muted font-normal">/</span>
              <span className="text-wb-text-primary">{repoInfo.repo}</span>
            </a>
          </div>
        </div>

        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="wb-pressable inline-flex items-center gap-1 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle hover:bg-wb-border-subtle border border-wb-border-subtle text-xs font-semibold text-wb-text-primary transition-colors shrink-0"
        >
          <span>访问仓库</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* 仓库描述 */}
      <p className="mt-3 text-xs sm:text-sm text-wb-text-secondary leading-relaxed line-clamp-2">
        {loading ? '正在读取 GitHub 项目详情与指标...' : data?.description || '暂无描述信息'}
      </p>

      {/* 底部指标元数据: 语言、Star、Fork、开源协议 */}
      <div className="mt-3 pt-2.5 border-t border-wb-border-subtle/60 flex flex-wrap items-center gap-4 text-xs font-mono text-wb-text-muted">
        {data?.language && (
          <div className="flex items-center gap-1.5 font-medium text-wb-text-primary">
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{ backgroundColor: langColor || '#8b949e' }}
            />
            <span>{data.language}</span>
          </div>
        )}

        {data && data.stargazers_count > 0 && (
          <div className="flex items-center gap-1 hover:text-wb-text-primary transition-colors">
            <Star className="w-3.5 h-3.5 fill-wb-warn text-wb-warn" />
            <span className="font-semibold">{formatCount(data.stargazers_count)}</span>
          </div>
        )}

        {data && data.forks_count > 0 && (
          <div className="flex items-center gap-1 hover:text-wb-text-primary transition-colors">
            <GitFork className="w-3.5 h-3.5" />
            <span>{formatCount(data.forks_count)}</span>
          </div>
        )}

        {data?.license && (
          <div className="flex items-center gap-1 hover:text-wb-text-primary transition-colors">
            <Scale className="w-3.5 h-3.5" />
            <span>{data.license.spdx_id || data.license.name}</span>
          </div>
        )}
      </div>
    </div>
  );
};

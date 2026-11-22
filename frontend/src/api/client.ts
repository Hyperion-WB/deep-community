import axios from 'axios';

const API_BASE = '/api';

// 图片/动图上传专用超时：大 GIF 在弱网上行可能远超全局 15s，
// 用全局超时会把「还在传」误判成失败，请求被 abort 后用户只能重来一遍。
export const UPLOAD_TIMEOUT = 180000;

export const apiClient = axios.create({
  baseURL: API_BASE,
  // 全局超时：避免接口挂起导致页面永久骨架屏
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器: 附加 Access Token
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * 将后端 FastAPI 返回的 422 验证错误对象或数组安全转换为易读的友好中文错误提示字符串，
 * 杜绝因为 detail 为对象直接传入 React JSX 导致 Minified React error #31 白屏崩溃。
 */
export function formatApiErrorDetail(detail: any): string {
  if (!detail) return '操作失败，请重试';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((d: any) => {
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object') {
        const fieldLoc = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : '';
        const fieldNames: Record<string, string> = {
          username: '用户名',
          email: '电子邮箱',
          password: '密码',
          title: '文章标题',
          content_md: '文章正文',
          content: '内容',
          code: '邀请码',
        };
        const name = fieldNames[fieldLoc] || (fieldLoc ? String(fieldLoc) : '');
        if (d.type === 'string_too_short') {
          return `${name ? name + ' ' : ''}长度不能少于 ${d.ctx?.min_length || 3} 个字符`;
        }
        if (d.type === 'string_too_long') {
          const max = d.ctx?.max_length;
          return max
            ? `${name ? name + ' ' : ''}长度不能超过 ${max} 个字符`
            : `${name ? name + ' ' : ''}内容过长，请精简后再提交`;
        }
        if (d.type === 'string_pattern_mismatch') {
          return `${name ? name + ' ' : ''}格式不符合规范（仅支持汉字、英文字母、数字和下划线）`;
        }
        if (d.type === 'value_error') {
          return d.msg || '填写内容有误';
        }
        return `${name ? name + ': ' : ''}${d.msg || '格式错误'}`;
      }
      return String(d);
    });
    return messages.join('；');
  }
  if (typeof detail === 'object') {
    return detail.msg || detail.message || JSON.stringify(detail);
  }
  return String(detail);
}

// 刷新令牌单例：首屏并发多个 401 时只发一次 /auth/refresh，
// 避免"后到的刷新用了旧 refresh token 而失败"导致被误登出
let refreshPromise: Promise<string> | null = null;

// refresh token 现在由后端写入 HttpOnly Cookie（JS 读不到），
// 历史版本可能残留在 localStorage，这里主动清理，避免被 XSS 读取后继续可用。
try {
  localStorage.removeItem('refresh_token');
} catch {}

// 多标签页协作：任一标签刷新成功后广播新的 access token，其他标签立即同步
const authChannel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('geek_auth')
    : null;

if (authChannel) {
  authChannel.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === 'token_refreshed' && data.access_token) {
      try {
        localStorage.setItem('access_token', data.access_token);
      } catch {}
    } else if (data?.type === 'logout') {
      try {
        localStorage.removeItem('access_token');
      } catch {}
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
  });
}

export const broadcastLogout = () => {
  authChannel?.postMessage({ type: 'logout' });
};

export const refreshAccessToken = (): Promise<string> => {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      // refresh token 存在 HttpOnly Cookie（path=/api/auth），同源请求会自动携带，
      // 前端不接触也读不到它，因此这里不再校验本地是否有值
      // 必须带超时：请求挂起时 refreshPromise 永不 settle，
      // 之后所有 401 都会复用这个僵尸 Promise，页面表现为永久卡住、登录框不弹。
      const res = await axios.post(`${API_BASE}/auth/refresh`, undefined, {
        withCredentials: true,
        timeout: 15000,
      });
      const { access_token } = res.data;
      localStorage.setItem('access_token', access_token);
      authChannel?.postMessage({ type: 'token_refreshed', access_token });
      return access_token as string;
    })();
    // 无论成功失败都释放单例，避免后续 401 拿到已失效的 Promise
    refreshPromise.catch(() => {}).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

// 响应拦截器: 401 自动使用 Refresh Token 续签，并全局防范 422 异常对象导致 React 白屏
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    // nginx 限流（429）与网关错误直接返回 HTML 页面，不带 detail 字段。
    // 若原样抛给上层，界面只能显示"登录失败/操作失败"，用户无法区分"被限流"与"服务异常"。
    const resp = error.response;
    const hasReadableDetail = typeof resp?.data?.detail === 'string' && resp.data.detail.trim();
    if (resp && !hasReadableDetail) {
      if (resp.status === 429) {
        resp.data = { detail: '操作过于频繁，已被服务器限流，请等待约 1 分钟后再试' };
      } else if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        resp.data = { detail: '服务暂时不可用，请稍后重试' };
      }
    }

    // 全局防崩溃兜底：若 error.response.data.detail 不是字符串（例如 422 验证对象数组），统一格式化为可读字符串
    if (error.response?.data && error.response.data.detail !== undefined) {
      if (typeof error.response.data.detail !== 'string') {
        error.response.data.detail = formatApiErrorDetail(error.response.data.detail);
      }
    }

    // 被 nginx 限流（429）时对幂等的 GET 做两次退避重试：
    // 首屏并发十几个接口很容易瞬时撞上限流，重试一次通常就正常，
    // 没必要把「操作过于频繁」直接甩给用户。
    const retryMethod = String(error.config?.method || 'get').toLowerCase();
    if (error.response?.status === 429 && (retryMethod === 'get' || retryMethod === 'head')) {
      const retried = Number(error.config?.__rateRetry || 0);
      if (retried < 2) {
        error.config.__rateRetry = retried + 1;
        await new Promise((resolve) => setTimeout(resolve, retried === 0 ? 700 : 1600));
        return apiClient(error.config);
      }
    }

    const originalRequest = error.config;
    // 只有「拿不到 token 的认证流程」才跳过续签；/auth/me 必须走刷新，
    // 否则 refresh_token 有效也会被直接清空导致随机登出。
    const AUTH_FLOW_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout', '/auth/github/'];
    const requestUrl = typeof originalRequest?.url === 'string' ? originalRequest.url : '';
    const isAuthEndpoint = AUTH_FLOW_PATHS.some((path) => requestUrl.includes(path));
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      try {
        const accessToken = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return apiClient(originalRequest);
      } catch (refreshErr: any) {
        const status = refreshErr?.response?.status;
        // 只有服务端明确判定凭证无效（401/403）才登出。
        // 网络抖动、502、超时也会走到这里，把用户踢下线属于误伤 —— 让请求失败即可，
        // 下一个请求会带着仍然有效的 Cookie 重试。
        if (status === 401 || status === 403) {
          localStorage.removeItem('access_token');
          // 不用 location.href='/' 硬跳转：保留当前地址（含 ?post= 深链），由 App 处理
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        throw refreshErr;
      }
    }
    return Promise.reject(error);
  }
);

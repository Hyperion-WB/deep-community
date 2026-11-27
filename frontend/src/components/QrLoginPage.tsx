import React, { useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { apiClient, formatApiErrorDetail } from '../api/client';

export const QrLoginPage: React.FC = () => {
  const token = new URLSearchParams(window.location.search).get('qr_login') || '';
  const [info, setInfo] = useState<{ session_id: string; username: string; nickname: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    window.history.replaceState({}, '', window.location.pathname);
    if (!token) { setError('二维码链接无效'); return; }
    apiClient.post('/auth/qr/scan', { scan_token: token })
      .then((res) => apiClient.get('/auth/qr/scan-info', { params: { session_id: res.data.session_id } }))
      .then((res) => setInfo(res.data))
      .catch((err) => setError(formatApiErrorDetail(err.response?.data?.detail) || '无法读取登录请求，请重新扫描'));
  }, [token]);

  const confirm = async () => {
    if (!info || busy) return;
    setBusy(true);
    try {
      await apiClient.post('/auth/qr/confirm', { session_id: info.session_id });
      setDone(true);
    } catch (err: any) {
      setError(formatApiErrorDetail(err.response?.data?.detail) || '确认失败，请重新扫描');
    } finally { setBusy(false); }
  };

  return <main className="min-h-[100dvh] bg-wb-bg-page px-5 py-10 text-wb-text-primary">
    <section className="mx-auto flex min-h-[70dvh] max-w-md flex-col justify-center rounded-3xl border border-wb-border-subtle bg-wb-bg-elevated p-7 text-center shadow-xl sm:p-9">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-wb-bg-subtle text-wb-text-primary"><ShieldCheck className="h-8 w-8" /></div>
      <h1 className="text-xl font-bold">确认电脑端登录</h1>
      {error ? <p className="mt-5 rounded-2xl bg-wb-danger/10 p-4 text-sm text-wb-danger">{error}</p> : done ? <div className="mt-6 rounded-2xl bg-wb-success/10 p-5 text-sm text-wb-text-secondary"><CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-wb-success" />已确认登录，请返回电脑继续使用。</div> : info ? <>
        <p className="mt-3 text-sm text-wb-text-muted">此操作将使用当前账号在电脑上登录</p>
        <div className="my-7 rounded-2xl border border-wb-border-subtle bg-wb-bg-subtle p-5"><p className="text-xs text-wb-text-muted">当前登录账号</p><p className="mt-1 text-lg font-semibold">{info.nickname}</p><p className="text-xs text-wb-text-muted">@{info.username}</p></div>
        <button onClick={confirm} disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-wb-text-primary text-sm font-semibold text-wb-bg-page disabled:opacity-60">{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}确认登录电脑</button>
        <p className="mt-4 text-xs leading-relaxed text-wb-text-muted">请确认这是你本人发起的登录请求。若非本人操作，请关闭此页面。</p>
      </> : <div className="mt-8 flex justify-center"><LoaderCircle className="h-6 w-6 animate-spin text-wb-text-muted" /></div>}
    </section>
  </main>;
};

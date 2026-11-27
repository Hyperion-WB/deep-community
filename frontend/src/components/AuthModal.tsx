import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, KeyRound, Mail, Lock, User, Sparkles, ArrowLeft, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { apiClient, formatApiErrorDetail } from '../api/client';
import { SegmentedControl } from './SegmentedControl';
import { Modal } from './Modal';
import { Turnstile } from './Turnstile';
import { PasswordHint } from './PasswordHint';

const GithubIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={`${className} fill-current`} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

// Gitee 官方标记（圆形底 + G 字形镂空），取自 gitee.com/static/images/logo.svg
// 单色填充以匹配 GitHub 图标的视觉重量，避免灰底字母造成的割裂感
const GiteeIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={`${className} fill-current`} viewBox="-5 -5 100 100" aria-hidden="true">
    <mask id="gitee-mark-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="90" height="90">
      <rect x="0" y="0" width="90" height="90" fill="#fff" />
      <path fill="#000" d="M67.558546,39.8714292 L42.0857966,39.8714292 C40.8627004,39.8720094 39.8710953,40.8633548 39.8701949,42.0864508 L39.8687448,47.623783 C39.867826,48.8471055 40.8592652,49.8390642 42.0825879,49.8393845 C42.0827874,49.8393846 42.0829869,49.8393846 42.0831864,49.8387862 L57.5909484,49.838657 C58.8142711,49.8386283 59.8059783,50.830319 59.8059885,52.0536417 C59.8059885,52.0536479 59.8059885,52.053654 59.8059701,52.0536602 L59.8059701,52.6073539 L59.8059701,52.6073539 L59.8059701,53.161115 C59.8059701,56.8310831 56.8308731,59.80618 53.160905,59.80618 L32.1165505,59.80618 C30.8934034,59.806119 29.9018373,58.8145802 29.9017425,57.5914331 L29.9011625,36.5491188 C29.9008781,32.8791508 32.8758931,29.9039718 36.5458611,29.9038706 C36.5459222,29.9038706 36.5459833,29.9038706 36.5460443,29.9040538 L67.5523638,29.9040538 C68.77515,29.9026795 69.7666266,28.9118177 69.7687593,27.6890325 L69.7721938,22.1516997 C69.774326,20.928378 68.7832423,19.9360642 67.5599198,19.9353054 C67.5594619,19.9353051 67.5590039,19.935305 67.558546,19.9366784 L36.5479677,19.9366784 C27.3730474,19.9366784 19.935305,27.3744208 19.935305,36.549341 L19.935305,67.558546 C19.935305,68.7818687 20.927004,69.7735676 22.1503267,69.7735676 L54.8224984,69.7735676 C63.079746,69.7735676 69.7735676,63.079746 69.7735676,54.8224984 L69.7735676,42.0864509 C69.7735676,40.8631282 68.7818687,39.8714292 67.558546,39.8714292 Z" />
    </mask>
    <circle cx="44.854" cy="44.854" r="44.854" mask="url(#gitee-mark-mask)" />
  </svg>
);

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const AuthModal: React.FC<Props> = ({ isOpen, onClose, onSuccess }) => {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  // 忘记密码视图：独立于登录/注册 tab，避免 SegmentedControl 出现第三项
  const [resetMode, setResetMode] = useState(false);
  // 登录标识与注册资料分开存放：此前共用一个 email state，登录框输入的用户名会串到注册页邮箱里
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(true); // 默认勾选，方便流畅体验
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [giteeEnabled, setGiteeEnabled] = useState(false);
  // 邮箱服务状态：required=注册必须验证；configured=SMTP 已配置
  const [emailRequired, setEmailRequired] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [codeHint, setCodeHint] = useState('');
  const cooldownTimerRef = useRef<any>(null);
  // Cloudflare Turnstile：注册必验；登录在连续失败后出现；发信达到阈值后出现
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaSiteKey, setCaptchaSiteKey] = useState('');
  const [captchaNeeded, setCaptchaNeeded] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [qrMode, setQrMode] = useState(false);
  const [qrImage, setQrImage] = useState('');
  const [qrStatus, setQrStatus] = useState('pending');
  const [qrNonce, setQrNonce] = useState(0);
  const qrCredentials = useRef<{ scan_token: string; exchange_token: string } | null>(null);

  useEffect(() => {
    if (!isOpen || !qrMode || tab !== 'login' || resetMode) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const createQr = async () => {
      try {
        const response = await apiClient.post('/auth/qr/create');
        if (stopped) return;
        qrCredentials.current = { scan_token: response.data.scan_token, exchange_token: response.data.exchange_token };
        setQrImage(await QRCode.toDataURL(response.data.url, { width: 220, margin: 1, color: { dark: '#111827', light: '#ffffff' } }));
        const poll = async () => {
          if (stopped || !qrCredentials.current) return;
          try {
            const state = await apiClient.post('/auth/qr/status', qrCredentials.current);
            if (stopped) return;
            setQrStatus(state.data.status);
            if (state.data.status === 'scanned') setQrStatus('scanned');
            if (state.data.status === 'confirmed') {
              const exchanged = await apiClient.post('/auth/qr/exchange', qrCredentials.current);
              localStorage.setItem('access_token', exchanged.data.access_token);
              onSuccess();
              onClose();
              return;
            }
          } catch {
            if (!stopped) setQrStatus('expired');
            return;
          }
          timer = setTimeout(poll, 1800);
        };
        timer = setTimeout(poll, 1200);
      } catch {
        if (!stopped) setQrStatus('unavailable');
      }
    };
    setQrStatus('pending');
    setQrImage('');
    void createQr();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const credentials = qrCredentials.current;
      qrCredentials.current = null;
      if (credentials) void apiClient.post('/auth/qr/cancel', credentials).catch(() => {});
    };
  }, [isOpen, qrMode, tab, resetMode, qrNonce, onSuccess, onClose]);

  // 弹窗打开时探测可用登录方式与邮箱服务状态
  useEffect(() => {
    if (!isOpen) {
      // 关闭时清掉条款弹窗，否则下次打开登录框会被上次残留的状态直接弹出来
      setShowTermsModal(false);
      return;
    }
    apiClient.get('/auth/github/enabled').then((res) => {
      setGithubEnabled(Boolean(res.data?.enabled));
    }).catch(() => setGithubEnabled(false));
    apiClient.get('/auth/gitee/enabled').then((res) => {
      setGiteeEnabled(Boolean(res.data?.enabled));
    }).catch(() => setGiteeEnabled(false));
    apiClient.get('/auth/email/enabled').then((res) => {
      setEmailRequired(Boolean(res.data?.required));
      setEmailConfigured(Boolean(res.data?.configured));
    }).catch(() => {
      setEmailRequired(false);
      setEmailConfigured(false);
    });
    apiClient.get('/auth/captcha').then((res) => {
      setCaptchaEnabled(Boolean(res.data?.enabled));
      setCaptchaSiteKey(res.data?.site_key || '');
    }).catch(() => {
      setCaptchaEnabled(false);
      setCaptchaSiteKey('');
    });
  }, [isOpen]);

  // 卸载时清掉倒计时定时器，避免关闭弹窗后继续 setState
  useEffect(() => () => {
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
  }, []);

  const startCooldown = (seconds: number) => {
    setCodeCooldown(seconds);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCodeCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const sendEmailCode = async () => {
    if (codeSending || codeCooldown > 0) return;
    const email = (resetMode ? resetEmail : regEmail).trim();
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      setErrorMsg('请先填写有效的电子邮箱地址');
      return;
    }
    setErrorMsg('');
    setCodeHint('');
    setCodeSending(true);
    try {
      const res = await apiClient.post('/auth/email/code', {
        email,
        purpose: resetMode ? 'reset' : 'register',
        captcha_token: captchaEnabled ? captchaToken || undefined : undefined,
      });
      startCooldown(Number(res.data?.cooldown_seconds) || 60);
      setCodeHint(res.data?.message || '验证码已发送');
      // 内网自测模式下后端会直接回传验证码
      if (res.data?.dev_code) {
        setEmailCode(String(res.data.dev_code));
        setCodeHint('站点未配置邮件服务，已自动填入服务端验证码');
      }
    } catch (err: any) {
      const detail = formatApiErrorDetail(err.response?.data?.detail) || '验证码发送失败';
      setErrorMsg(detail);
      if (err.response?.headers?.['x-captcha-required'] === '1') {
        setCaptchaNeeded(true);
        setCaptchaToken('');
        setCaptchaKey((k) => k + 1);
      }
      const wait = /(\d+)\s*秒/.exec(detail);
      if (wait) startCooldown(Number(wait[1]));
    } finally {
      setCodeSending(false);
    }
  };

  // 注意：所有 Hook 必须位于提前 return 之前，否则打开弹窗时 Hook 数量变化会触发 React #310
  if (!isOpen) return null;

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');
    if (!resetEmail.trim() || !/\S+@\S+\.\S+/.test(resetEmail.trim())) {
      setErrorMsg('请输入有效的电子邮箱地址');
      return;
    }
    if (!emailCode.trim()) {
      setErrorMsg('请输入邮箱验证码');
      return;
    }
    if (resetPassword.length < 8) {
      setErrorMsg('新密码长度不能少于 8 位');
      return;
    }
    if (!/^[\x21-\x7E]+$/.test(resetPassword)) {
      setErrorMsg('密码仅支持不含空格的英文、数字与英文符号，不支持中文');
      return;
    }
    if (!/[A-Za-z]/.test(resetPassword) || !/\d/.test(resetPassword)) {
      setErrorMsg('密码需同时包含字母和数字');
      return;
    }
    if (captchaEnabled && !captchaToken) {
      setErrorMsg('请先完成人机验证');
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/auth/password/reset', {
        email: resetEmail.trim(),
        code: emailCode.trim(),
        new_password: resetPassword,
      });
      setResetMode(false);
      setTab('login');
      setResetPassword('');
      setEmailCode('');
      setCodeHint('');
      setSuccessMsg('密码已重置，请使用新密码登录');
    } catch (err: any) {
      setErrorMsg(formatApiErrorDetail(err.response?.data?.detail) || '重置失败，请检查验证码');
      if (err.response?.headers?.['x-captcha-required'] === '1') {
        setCaptchaNeeded(true);
        setCaptchaToken('');
        setCaptchaKey((k) => k + 1);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resetMode) {
      await handleResetSubmit(e);
      return;
    }
    setErrorMsg('');
    setSuccessMsg('');

    if (tab === 'register') {
      if (!agreedTerms) {
        setErrorMsg('请勾选同意《极客社区公约与平台服务协议》及《隐私政策》');
        return;
      }
      const trimmedUser = regUsername.trim();
      if (trimmedUser.length < 3 || trimmedUser.length > 32) {
        setErrorMsg('用户名长度需在 3 到 32 个字符之间');
        return;
      }
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(trimmedUser)) {
        setErrorMsg('用户名仅支持中文、英文字母、数字和下划线');
        return;
      }
      if (!regEmail.trim() || !/\S+@\S+\.\S+/.test(regEmail.trim())) {
        setErrorMsg('请输入有效的电子邮箱地址');
        return;
      }
      if (emailRequired && !emailCode.trim()) {
        setErrorMsg('请输入邮箱验证码完成验证');
        return;
      }
      if (captchaEnabled && !captchaToken) {
        setErrorMsg('请先完成人机验证');
        return;
      }
      if (password.length < 8) {
        setErrorMsg('密码长度不能少于 8 位');
        return;
      }
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        setErrorMsg('密码需同时包含字母和数字');
        return;
      }
      // 与后端规则一致：仅可见 ASCII，禁止中文/Emoji/空格，提前拦截避免提交后才报错
      if (!/^[\x21-\x7E]+$/.test(password)) {
        setErrorMsg('密码仅支持不含空格的英文、数字与英文符号，不支持中文');
        return;
      }
    } else {
      if (!loginIdentifier.trim()) {
        setErrorMsg('请输入用户名或邮箱');
        return;
      }
      if (!password) {
        setErrorMsg('请输入密码');
        return;
      }
      if (captchaNeeded && !captchaToken) {
        setErrorMsg('连续登录失败次数较多，请先完成人机验证');
        return;
      }
    }

    setLoading(true);

    try {
      if (tab === 'login') {
        const res = await apiClient.post('/auth/login', {
          username_or_email: loginIdentifier.trim(),
          password,
          captcha_token: captchaNeeded && captchaToken ? captchaToken : undefined,
        });
        // refresh token 由后端写入 HttpOnly Cookie，前端只保存短期 access token
        localStorage.setItem('access_token', res.data.access_token);
      } else {
        const res = await apiClient.post('/auth/register', {
          username: regUsername.trim(),
          email: regEmail.trim(),
          password,
          invite_code: inviteCode.trim() || undefined,
          email_code: emailCode.trim() || undefined,
          captcha_token: captchaEnabled && captchaToken ? captchaToken : undefined,
        });
        // 后端已保证「账号创建成功就一定返回可用 token」；
        // 万一真的没拿到，也不能报"注册失败"（账号其实已存在），提示去登录即可
        const token = res.data?.access_token;
        if (!token) {
          setErrorMsg('账号已创建成功，请直接登录');
          return;
        }
        localStorage.setItem('access_token', token);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(formatApiErrorDetail(err.response?.data?.detail) || '提交失败，请检查填写内容');
      if (err.response?.headers?.['x-captcha-required'] === '1') {
        setCaptchaNeeded(true);
        setCaptchaToken('');
        setCaptchaKey((k) => k + 1);
      }
    } finally {
      setLoading(false);
      // Turnstile token 一次性有效：提交后必须重新渲染，否则第二次提交必然失败
      if (captchaEnabled && captchaToken) {
        setCaptchaToken('');
        setCaptchaKey((k) => k + 1);
      }
    }
  };

  return (
    <>
      <Modal open={isOpen} onClose={onClose} widthClass="max-w-md">
        <div className="relative p-6 overflow-y-auto">
        {!resetMode && tab === 'login' && (
          <button type="button" onClick={() => setQrMode((value) => !value)}
            aria-label={qrMode ? '返回账号登录' : '扫码登录'}
            title={qrMode ? '返回账号登录' : '扫码登录'}
            className="absolute left-4 top-4 z-30 grid h-9 w-9 place-items-center rounded-xl border border-wb-border-subtle bg-wb-bg-elevated text-wb-text-secondary shadow-sm transition-all hover:-rotate-3 hover:border-wb-border-strong hover:text-wb-text-primary">
            {qrMode ? <ArrowLeft className="h-4 w-4" /> : <QrCode className="h-4 w-4 -rotate-6" />}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-wb-text-muted hover:text-wb-text-primary rounded-capsule transition-colors z-20"
        >
          <X className="w-4 h-4" />
        </button>

        <div className={`flex justify-center ${qrMode ? 'mb-0' : 'mb-5'}`}>
          {qrMode ? null : resetMode ? (
            <div className="flex items-center w-full">
              <button
                type="button"
                onClick={() => {
                  setResetMode(false);
                  setErrorMsg('');
                  setSuccessMsg('');
                }}
                className="inline-flex items-center gap-1 text-xs text-wb-text-secondary hover:text-wb-text-primary transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                返回登录
              </button>
              <span className="flex-1 text-center text-sm font-bold text-wb-text-primary">找回密码</span>
              <span className="w-16" />
            </div>
          ) : (
            <SegmentedControl
              id="auth-modal"
              items={[
                { key: 'login', label: '登录账号' },
                { key: 'register', label: '注册通行证' },
              ]}
              activeKey={tab}
              onChange={(k) => {
                setTab(k as any);
                setErrorMsg('');
                setSuccessMsg('');
              }}
            />
          )}
        </div>

        {qrMode && tab === 'login' && !resetMode ? (
          <div className="flex min-h-[350px] flex-col items-center justify-center text-center">
            <div className="relative flex h-60 w-60 items-center justify-center overflow-hidden rounded-[28px] border border-wb-border-subtle bg-white p-3.5 shadow-[0_18px_45px_rgba(0,0,0,0.10)]">
              {qrImage ? (
                <img src={qrImage} alt="电脑端登录二维码" className="h-full w-full" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-wb-text-muted">
                  <div className="h-7 w-7 animate-spin rounded-full border-2 border-wb-text-muted border-t-transparent" />
                  <span className="text-[10px]">{qrStatus === 'unavailable' ? '扫码服务暂不可用' : '正在生成…'}</span>
                </div>
              )}
              {qrStatus === 'scanned' && (
                <div className="absolute inset-0 grid place-items-center bg-wb-bg-page/85 backdrop-blur-[2px]">
                  <div className="rounded-2xl bg-wb-bg-surface px-4 py-3 text-xs font-semibold text-wb-text-primary shadow-lg">
                    已扫码，请在手机上确认
                  </div>
                </div>
              )}
            </div>
            <p className="mt-4 text-xs font-medium text-wb-text-secondary">
              {qrStatus === 'scanned' ? '已扫码，请在手机端点击「确认登录」'
                : qrStatus === 'confirmed' ? '登录成功，正在进入…'
                  : qrStatus === 'expired' ? '二维码已失效'
                    : qrStatus === 'unavailable' ? '扫码服务暂不可用，请使用账号密码登录'
                      : '使用已登录的手机扫描二维码'}
            </p>
            {(qrStatus === 'expired' || qrStatus === 'unavailable') && (
              <button type="button" onClick={() => setQrNonce((value) => value + 1)}
                className="mt-3 inline-flex h-8 items-center rounded-capsule border border-wb-border-subtle bg-wb-bg-surface px-3 text-2xs font-semibold text-wb-text-secondary hover:bg-wb-bg-subtle">
                刷新二维码
              </button>
            )}
            <p className="mt-2 text-[10px] text-wb-text-muted">二维码 2 分钟内有效 · 请确认是本人操作</p>
          </div>
        ) : errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-3 rounded-2xl bg-wb-danger/10 border border-wb-danger/20 text-wb-danger text-xs"
          >
            {errorMsg}
          </motion.div>
        )}

        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-3 rounded-2xl bg-wb-success/10 border border-wb-success/20 text-wb-success dark:text-wb-success text-xs"
          >
            {successMsg}
          </motion.div>
        )}

        {resetMode && (
          <p className="mb-3 text-2xs text-wb-text-muted leading-relaxed">
            输入注册邮箱获取验证码，验证通过后即可设置新密码。重置成功后，所有设备都需要重新登录。
          </p>
        )}

        {!qrMode && <form onSubmit={handleSubmit} className="space-y-3.5">
          <motion.div layout className="space-y-3.5">
            {tab === 'register' && !resetMode && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <label className="block text-xs font-medium text-wb-text-secondary mb-1.5">用户名</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="text"
                    required
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="3-32位字符"
                    className="w-full pl-10 pr-4 h-10 text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                  />
                </div>
              </motion.div>
            )}

            <div>
              <label className="block text-xs font-medium text-wb-text-secondary mb-1.5">
                {resetMode ? '注册邮箱' : tab === 'login' ? '用户名或邮箱' : '绑定邮箱'}
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                <input
                  type={tab === 'login' && !resetMode ? 'text' : 'email'}
                  required
                  value={resetMode ? resetEmail : tab === 'login' ? loginIdentifier : regEmail}
                  onChange={(e) => {
                    if (resetMode) {
                      setResetEmail(e.target.value);
                    } else if (tab === 'login') {
                      setLoginIdentifier(e.target.value);
                    } else {
                      setRegEmail(e.target.value);
                    }
                  }}
                  placeholder={
                    resetMode ? '请输入注册邮箱' : tab === 'login' ? '请输入账号或邮箱' : 'you@domain.com'
                  }
                  className="w-full pl-10 pr-4 h-10 text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label className="block text-xs font-medium text-wb-text-secondary">
                  {resetMode ? '新密码' : '密码'}
                </label>
                {!resetMode && tab === 'login' && (
                  <button
                    type="button"
                    onClick={() => {
                      setResetMode(true);
                      setErrorMsg('');
                      setSuccessMsg('');
                      setEmailCode('');
                      setPassword('');
                    }}
                    className="text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:underline transition-colors"
                  >
                    忘记密码？
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                <input
                  type="password"
                  required
                  value={resetMode ? resetPassword : password}
                  onChange={(e) =>
                    resetMode ? setResetPassword(e.target.value) : setPassword(e.target.value)
                  }
                  placeholder={
                    resetMode || tab === 'register'
                      ? '至少 8 位，需含字母和数字'
                      : '请输入密码'
                  }
                  className="w-full pl-10 pr-4 h-10 text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                />
              </div>
              {/* 注册 / 重置密码才需要提示规则，登录时不用打扰 */}
              {(resetMode || tab === 'register') && (
                <PasswordHint
                  value={resetMode ? resetPassword : password}
                  username={tab === 'register' ? regUsername : ''}
                  email={resetMode ? resetEmail : regEmail}
                />
              )}
            </div>

            {(resetMode || tab === 'register') && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-wb-text-secondary">
                    邮箱验证码
                    {!resetMode && !emailRequired && (
                      <span className="ml-1 text-2xs text-wb-text-muted">(选填)</span>
                    )}
                  </label>
                  {!emailConfigured && !resetMode ? (
                    <span className="text-2xs text-wb-text-muted">邮件服务未配置</span>
                  ) : (
                    <button
                      type="button"
                      onClick={sendEmailCode}
                      disabled={codeSending || codeCooldown > 0}
                      className="text-2xs font-semibold text-wb-text-primary hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                    >
                      {codeSending ? '发送中...' : codeCooldown > 0 ? `${codeCooldown}s 后重发` : '发送验证码'}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    required={emailRequired || resetMode}
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\s/g, ''))}
                    placeholder="6 位数字验证码"
                    className="w-full pl-10 pr-4 h-10 text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary tracking-[0.2em] transition-colors"
                  />
                </div>
                {codeHint && <p className="mt-1 text-2xs text-wb-text-muted">{codeHint}</p>}
                {!emailConfigured && !resetMode && (
                  <p className="mt-1 text-2xs text-wb-warn dark:text-wb-warn">
                    站点尚未配置邮件服务，验证码可留空直接注册；配置 SMTP 后将强制验证邮箱。
                  </p>
                )}
              </motion.div>
            )}

            {tab === 'register' && !resetMode && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-wb-text-secondary">邀请码 (选填)</label>
                  <span className="text-2xs text-wb-text-muted flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-wb-text-primary" /> 有码即成 Lv.1 正式会员
                  </span>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="留空则成为见习会员，活跃 5 天自动转正"
                    className="w-full pl-10 pr-4 h-10 text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary placeholder:text-xs transition-colors"
                  />
                </div>
              </motion.div>
            )}

            {tab === 'register' && !resetMode && (
              <div className="flex items-start gap-2 pt-1 text-xs text-wb-text-secondary select-none">
                <input
                  type="checkbox"
                  id="agree-terms"
                  checked={agreedTerms}
                  onChange={(e) => setAgreedTerms(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 rounded border-wb-border-subtle accent-wb-text-primary text-wb-text-primary focus:ring-0 cursor-pointer shrink-0"
                />
                <label htmlFor="agree-terms" className="leading-relaxed cursor-pointer text-2xs text-wb-text-muted">
                  注册即代表已阅读并同意我们的{' '}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setShowTermsModal(true);
                    }}
                    className="text-wb-text-primary underline font-medium hover:opacity-80 inline"
                  >
                    《社区公约与平台服务协议》
                  </button>{' '}
                  与{' '}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setShowTermsModal(true);
                    }}
                    className="text-wb-text-primary underline font-medium hover:opacity-80 inline"
                  >
                    《隐私政策》
                  </button>
                </label>
              </div>
            )}
          </motion.div>

          {captchaEnabled && (captchaNeeded || tab === 'register' || resetMode) && captchaSiteKey && (
            <div className="flex justify-center pt-1">
              <Turnstile
                key={captchaKey}
                siteKey={captchaSiteKey}
                onToken={setCaptchaToken}
              />
            </div>
          )}

          <motion.button
            layout
            type="submit"
            disabled={loading}
            className="wb-pressable w-full mt-2 h-11 rounded-capsule bg-wb-text-primary text-wb-bg-page text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? '处理中...' : resetMode ? '重置密码' : tab === 'login' ? '立即登录' : '创建通行证'}
          </motion.button>

          {/* 第三方登录（后端未配置密钥时自动隐藏） */}
          {!resetMode && tab === 'login' && (githubEnabled || giteeEnabled) && (
            <>
              <div className="flex items-center gap-3 pt-1">
                <div className="h-px flex-1 bg-wb-border-subtle" />
                <span className="text-3xs text-wb-text-muted">或</span>
                <div className="h-px flex-1 bg-wb-border-subtle" />
              </div>
              <div className={githubEnabled && giteeEnabled ? 'grid grid-cols-2 gap-2' : 'space-y-2'}>
                {githubEnabled && (
                  <a
                    href="/api/auth/github/login"
                    className="wb-pressable flex items-center justify-center gap-2 w-full h-11 rounded-capsule border border-wb-border-strong text-xs font-semibold text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                  >
                    <GithubIcon className="w-4 h-4" />
                    使用 GitHub 登录
                  </a>
                )}
                {giteeEnabled && (
                  <a
                    href="/api/auth/gitee/login"
                    className="wb-pressable flex items-center justify-center gap-2 w-full h-11 rounded-capsule border border-wb-border-strong text-xs font-semibold text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                  >
                    <GiteeIcon className="w-4 h-4" />
                    使用 Gitee 登录
                  </a>
                )}
              </div>
            </>
          )}
        </form>}
        </div>
      </Modal>

      {/* 社区公约与隐私政策模态弹窗 */}
      {showTermsModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in"
          onClick={() => setShowTermsModal(false)}
        >
          <div
            className="w-full max-w-lg bg-wb-bg-elevated border border-wb-border-strong rounded-3xl p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle shrink-0">
              <div className="space-y-0.5">
                <h3 className="font-bold text-base text-wb-text-primary font-mono tracking-tight">
                  极客社区公约与平台服务协议
                </h3>
                <p className="text-2xs text-wb-text-muted">
                  Geek Community Code of Conduct & Privacy Policy · v4.2
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTermsModal(false)}
                className="p-1.5 text-wb-text-muted hover:text-wb-text-primary rounded-capsule hover:bg-wb-bg-subtle transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 text-xs text-wb-text-secondary leading-relaxed pr-1 font-sans">
              <div className="p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-1">
                <p className="font-semibold text-wb-text-primary">前言与社区愿景：</p>
                <p className="text-2xs text-wb-text-muted">
                  极客社区致力于打造纯粹、崇尚工程技术与极简黑白工业美学的专业开发者社区。请在注册成为正式成员前，仔细阅读以下社区公约与准则。
                </p>
              </div>

              <div className="space-y-1.5">
                <h4 className="font-bold text-wb-text-primary text-xs">一、 社区准则与交流公约</h4>
                <p className="text-2xs text-wb-text-muted">
                  1. <strong>理性实证</strong>：鼓励严谨的技术分享、架构探讨与深度创作，拒绝虚假吹嘘与情绪化引战。<br />
                  2. <strong>包容与尊重</strong>：坚决抵制任何形式的人身攻击、低俗辱骂、歧视言论及垃圾营销引流广告。<br />
                  3. <strong>杜绝水帖与作弊</strong>：禁止利用脚本、自动化工具或恶意反复发帖下架手段刷取社区等级与经验值，一经核实将永久封禁。
                </p>
              </div>

              <div className="space-y-1.5">
                <h4 className="font-bold text-wb-text-primary text-xs">二、 创作知识产权与内容管理</h4>
                <p className="text-2xs text-wb-text-muted">
                  1. <strong>原创著作权</strong>：作者对其在社区发布的所有文章、代码片段与设计作品享有完整的署名权与版权。<br />
                  2. <strong>自主下架与草稿保护</strong>：社区尊重作者的创作打磨自由，作者可随时将已发布文章下架存入个人草稿箱重新润色，下架不会扣除已获得经验。<br />
                  3. <strong>合规审查</strong>：文章内容须遵守法律法规，禁止发布泄露他人隐私、商业秘密或侵犯知识产权的内容。
                </p>
              </div>

              <div className="space-y-1.5">
                <h4 className="font-bold text-wb-text-primary text-xs">三、 用户隐私保护与数据安全</h4>
                <p className="text-2xs text-wb-text-muted">
                  1. <strong>密码哈希加密</strong>：所有用户密码均经过不可逆高强度加盐算法加密存储，技术人员亦无法解密。<br />
                  2. <strong>匿名真实保护</strong>：在匿名评论与交流场景中，系统在数据层进行 UID 强制隔离脱敏，杜绝抓包反查。<br />
                  3. <strong>绝不转售数据</strong>：社区严正承诺不会向任何第三方商业机构转让、出租或出售您的任何个人资料与交流动态。
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-wb-border-subtle flex items-center justify-between gap-2 shrink-0">
              <a
                href="/?tab=rules"
                target="_blank"
                rel="noreferrer"
                className="text-2xs text-wb-text-secondary hover:text-wb-text-primary underline underline-offset-4"
              >
                查看完整自治公约与入站必读规范 &rarr;
              </a>
              <button
                type="button"
                onClick={() => {
                  setAgreedTerms(true);
                  setShowTermsModal(false);
                }}
                className="wb-pressable px-5 py-2 text-xs font-semibold rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 shadow-sm"
              >
                我已了解并同意
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

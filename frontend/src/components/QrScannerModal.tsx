import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import jsQR from 'jsqr';
import { Camera, ImagePlus, LoaderCircle, ScanLine, X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

const errorText = (error: unknown) => {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError') return '摄像头权限被拒绝，请在浏览器设置中允许相机，或直接从相册选择二维码图片。';
  if (name === 'NotFoundError') return '没有找到可用摄像头，可以从相册选择二维码图片。';
  if (name === 'NotReadableError') return '摄像头被其他应用占用，请关闭其他相机应用后重试。';
  return '无法打开摄像头，可以从相册选择二维码图片。';
};

export const QrScannerModal: React.FC<Props> = ({ onClose }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef(0);
  const handledRef = useRef(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  const stopCamera = useCallback(() => {
    if (scanTimerRef.current) {
      window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = 0;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const handleResult = useCallback((text: string): boolean => {
    if (handledRef.current) return false;
    try {
      const url = new URL(text, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error('foreign');
      if (!url.searchParams.has('qr_login')) throw new Error('not-login');
      handledRef.current = true;
      stopCamera();
      window.location.assign(url.toString());
      return true;
    } catch {
      setError('这不是本站的登录二维码，请对准电脑端登录窗口里的二维码。');
      return false;
    }
  }, [stopCamera]);

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || handledRef.current) return;
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const maxWidth = 640;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        const result = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
        if (result?.data && handleResult(result.data)) return;
      }
    }
    scanTimerRef.current = window.setTimeout(scanFrame, 220);
  }, [handleResult]);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持摄像头扫码，可以从相册选择二维码图片。');
        setStarting(false);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setStarting(false);
        scanTimerRef.current = window.setTimeout(scanFrame, 300);
      } catch (cameraError) {
        if (!cancelled) {
          setError(errorText(cameraError));
          setStarting(false);
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [scanFrame, stopCamera]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const decodeImage = (file: File) => {
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        const maxWidth = 900;
        const scale = Math.min(1, maxWidth / image.width);
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          setError('图片解析失败，请换一张二维码截图。');
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
        if (result?.data) handleResult(result.data);
        else setError('没有识别到二维码，请换一张更清晰的图片。');
      };
      image.onerror = () => setError('图片读取失败，请重试。');
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  };

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="扫一扫"
        className="w-full max-w-md overflow-hidden rounded-3xl border border-wb-border-subtle bg-wb-bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-wb-border-subtle px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-bold"><ScanLine className="h-4 w-4 text-wb-brand" />扫一扫</div>
          <button type="button" onClick={onClose} aria-label="关闭扫一扫"
            className="grid h-8 w-8 place-items-center rounded-full text-wb-text-muted hover:bg-wb-bg-subtle hover:text-wb-text-primary">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-4">
          <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="relative h-[62%] w-[62%] rounded-2xl border border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
                <span className="absolute -left-px -top-px h-7 w-7 rounded-tl-2xl border-l-2 border-t-2 border-white" />
                <span className="absolute -right-px -top-px h-7 w-7 rounded-tr-2xl border-r-2 border-t-2 border-white" />
                <span className="absolute -bottom-px -left-px h-7 w-7 rounded-bl-2xl border-b-2 border-l-2 border-white" />
                <span className="absolute -bottom-px -right-px h-7 w-7 rounded-br-2xl border-b-2 border-r-2 border-white" />
              </div>
            </div>
            {starting && (
              <div className="absolute inset-0 grid place-items-center bg-black/60 text-xs text-white">
                <span className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />正在打开摄像头…</span>
              </div>
            )}
          </div>

          <p className="mt-3 text-center text-xs leading-relaxed text-wb-text-secondary">
            将电脑端登录窗口里的二维码放入框内
          </p>
          {error && <p role="alert" className="mt-2 rounded-xl bg-wb-danger/10 px-3 py-2 text-xs text-wb-danger">{error}</p>}

          <label className="mt-3 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-wb-border-subtle bg-wb-bg-subtle text-xs font-semibold text-wb-text-secondary hover:text-wb-text-primary">
            <ImagePlus className="h-4 w-4" />从相册选择二维码
            <input type="file" accept="image/*" className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) decodeImage(file);
              }} />
          </label>
          <p className="mt-2 flex items-center justify-center gap-1 text-[10px] text-wb-text-muted">
            <Camera className="h-3 w-3" />需要使用相机权限；只在本地识别，不会上传图片
          </p>
        </div>
      </section>
    </div>,
    document.body,
  );
};

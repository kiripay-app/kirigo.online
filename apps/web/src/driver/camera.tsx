import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/**
 * In-app camera only — no gallery — so a proof photo is always taken on the spot.
 * Returns a JPEG blob plus where and when it was taken.
 */
export function CameraShot({ facing = 'environment', label, onShot }: {
  facing?: 'environment' | 'user'; label: string; onShot: (b: Blob, at: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((s) => { stream = s; if (video.current) { video.current.srcObject = s; void video.current.play(); } })
      .catch(() => setErr('Camera blocked. Allow camera access for KiriGo in your phone settings.'));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [facing]);
  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    const scale = Math.min(1, 1280 / v.videoWidth);
    c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => b && onShot(b, Date.now()), 'image/jpeg', 0.8);
  };
  return (
    <div>
      {err ? <div className="error">{err}</div> : <video ref={video} playsInline muted />}
      <button className="block" style={{ marginTop: 8 }} onClick={snap} disabled={!!err}>{label}</button>
    </div>
  );
}

/** Scan the customer's QR. */
export function QrScan({ onCode }: { onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const canvas = document.createElement('canvas');
    const tick = () => {
      if (stop) return;
      const v = video.current;
      if (v && v.videoWidth) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height);
        if (found?.data) { stop = true; onCode(found.data); return; }
      }
      requestAnimationFrame(tick);
    };
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => { stream = s; if (video.current) { video.current.srcObject = s; void video.current.play(); tick(); } })
      .catch(() => setErr('Camera blocked. Type the 4-digit code instead.'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return err ? <div className="error">{err}</div> : <video ref={video} playsInline muted />;
}

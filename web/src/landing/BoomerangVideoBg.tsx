import { useEffect, useRef, useState } from "react";

const SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260715_090628_7052d8a6-a094-4341-a4a2-ad58493a67a9.mp4";
const MAX_W = 960;
// ponytail: frames are kept decoded (~2 MB each at 960 px); phones and low-memory devices capture at half
// width, which divides memory by four for a background that is scaled up anyway.
const captureWidth = () =>
  ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4 || window.innerWidth < 768
    ? MAX_W / 2
    : MAX_W;
const FRAME_MS = 1000 / 30;

/**
 * Plays the clip once while copying each frame to an offscreen canvas, then loops those frames
 * forward and backward on a display canvas forever (a "boomerang").
 * ponytail: ~240 frames at 960x540 is roughly 500 MB of canvas memory on desktop (see captureWidth).
 */
export function BoomerangVideoBg() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<HTMLCanvasElement[] | null>(null);

  // Capture pass.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const freeze = () => {
        video.pause();
        video.currentTime = 0;
      };
      video.addEventListener("loadeddata", freeze);
      return () => video.removeEventListener("loadeddata", freeze);
    }

    const captured: HTMLCanvasElement[] = [];
    const maxW = captureWidth();
    const hasVfc = "requestVideoFrameCallback" in video;
    let lastTime = -1;
    let stopped = false;
    let rafId = 0;
    let vfcId = 0;

    const grab = () => {
      if (!video.videoWidth || video.currentTime === lastTime) return;
      lastTime = video.currentTime;
      const w = Math.min(maxW, video.videoWidth);
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")?.drawImage(video, 0, 0, w, h);
      captured.push(c);
    };

    const cancel = () => {
      cancelAnimationFrame(rafId);
      if (hasVfc) video.cancelVideoFrameCallback(vfcId);
    };

    const tick = () => {
      if (stopped) return;
      grab();
      if (hasVfc) vfcId = video.requestVideoFrameCallback(tick);
      else rafId = requestAnimationFrame(tick);
    };

    const onEnded = () => {
      grab();
      stopped = true;
      cancel();
      if (captured.length > 1) setFrames(captured);
    };

    video.addEventListener("ended", onEnded);
    video.currentTime = 0;
    video.play().then(tick, () => {
      /* autoplay blocked: the live video stays visible as a static poster */
    });

    return () => {
      stopped = true;
      cancel();
      video.removeEventListener("ended", onEnded);
      video.pause();
    };
  }, []);

  // Ping-pong playback.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!frames || !canvas || !ctx) return;
    canvas.width = frames[0].width;
    canvas.height = frames[0].height;
    let i = frames.length - 1;
    let dir = -1;
    const id = window.setInterval(() => {
      ctx.drawImage(frames[i], 0, 0);
      if (i + dir < 0 || i + dir >= frames.length) dir = -dir;
      i += dir;
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [frames]);

  return (
    <div className="absolute inset-0 z-0 scale-[1.15] origin-top overflow-hidden" aria-hidden="true">
      <video
        ref={videoRef}
        src={SRC}
        muted
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        className="w-full h-full object-cover object-top"
        style={{ display: frames ? "none" : undefined }}
      />
      <canvas
        ref={canvasRef}
        className="w-full h-full object-cover object-top"
        style={{ display: frames ? undefined : "none" }}
      />
    </div>
  );
}

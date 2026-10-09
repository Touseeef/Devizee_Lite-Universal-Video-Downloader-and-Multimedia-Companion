// src/components/common/WaveformVisualizer.tsx
import { useEffect, useRef } from "react";

export function WaveformVisualizer({
    mediaElement,
    isPlaying,
    onSeek,
    width = 80,
    height = 22,
    barCount = 24,
}: {
    mediaElement: HTMLMediaElement | null;
    isPlaying: boolean;
    onSeek?: (seconds: number) => void;
    width?: number;
    height?: number;
    barCount?: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const progressRef = useRef(0);


    // Track playback position via standard HTML5 media events (0% CPU overhead, no polling RAF)
    useEffect(() => {
        if (!mediaElement) {
            progressRef.current = 0;
            return;
        }

        const updateProgress = () => {
            const d = mediaElement.duration;
            const c = mediaElement.currentTime;
            progressRef.current = d && isFinite(d) && d > 0 ? c / d : 0;
        };

        updateProgress();
        mediaElement.addEventListener("timeupdate", updateProgress);
        mediaElement.addEventListener("seeked", updateProgress);
        mediaElement.addEventListener("ended", updateProgress);
        mediaElement.addEventListener("loadedmetadata", updateProgress);

        return () => {
            mediaElement.removeEventListener("timeupdate", updateProgress);
            mediaElement.removeEventListener("seeked", updateProgress);
            mediaElement.removeEventListener("ended", updateProgress);
            mediaElement.removeEventListener("loadedmetadata", updateProgress);
        };
    }, [mediaElement]);

    // Animated draw loop with HiDPI support & audio physics
    // D4: theme colors are re-read inside the loop (throttled to 1× per 30 frames)
    // so switching themes mid-playback recolors the waveform live.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        const dpr = window.devicePixelRatio || 1;

        // Set display size vs buffer size for razor-sharp rendering on Retina/HiDPI
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.scale(dpr, dpr);

        // Cache theme colors here so we don't call getComputedStyle on every frame.
        // Refreshed every ~0.5s from within the draw loop below.
        let accent = "#14b8a6";
        let inactive = "#475569";
        const refreshColors = () => {
            const cs = getComputedStyle(document.documentElement);
            accent = cs.getPropertyValue("--color-accent").trim() || "#14b8a6";
            inactive = cs.getPropertyValue("--color-border-strong").trim() || "#475569";
        };
        refreshColors();

        const gap = 1.5;
        const barW = Math.max(1.5, (width - (barCount - 1) * gap) / barCount);
        const midY = height / 2;

        let raf = 0;
        let phase = 0;
        let last: number | null = null;

        const drawResting = () => {
            refreshColors();
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = inactive;
            ctx.globalAlpha = 0.35;
            for (let i = 0; i < barCount; i++) {
                const barH = 2;
                const x = i * (barW + gap);
                const y = midY - 1;
                ctx.beginPath();
                if (typeof ctx.roundRect === "function") {
                    ctx.roundRect(x, y, barW, barH, 1);
                } else {
                    ctx.rect(x, y, barW, barH);
                }
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        };

        const isMediaActuallyPlaying = () => {
            if (!isPlaying) return false;
            if (mediaElement) {
                return !mediaElement.paused && !mediaElement.ended;
            }
            return isPlaying;
        };

        // If not playing or media is paused/ended, render resting state and do not loop
        if (!isMediaActuallyPlaying()) {
            drawResting();
            return;
        }

        let frameCount = 0;
        const draw = (now: number) => {
            if (!isMediaActuallyPlaying()) {
                drawResting();
                return;
            }

            raf = requestAnimationFrame(draw);
            if (last !== null) phase += (now - last) * 0.007;
            last = now;

            // D4: refresh theme colors every 30 frames (~0.5s at 60fps) so
            // theme switches recolor the bars without a full re-mount.
            frameCount++;
            if (frameCount % 30 === 0) refreshColors();

            ctx.clearRect(0, 0, width, height);

            for (let i = 0; i < barCount; i++) {
                // Realistic multi-harmonic frequency distribution
                // Center-weighted bass & sub-bass harmonics
                const centerWeight = Math.sin((i / barCount) * Math.PI);
                const s1 = Math.abs(Math.sin(phase * 1.2 + i * 0.45));
                const s2 = Math.abs(Math.sin(phase * 2.1 + i * 0.95));
                const s3 = Math.abs(Math.cos(phase * 0.8 + i * 1.35));
                const s4 = Math.abs(Math.sin(phase * 3.4 + i * 0.2));

                const energy = (s1 * 0.35 + s2 * 0.3 + s3 * 0.2 + s4 * 0.15) * (0.6 + centerWeight * 0.4);
                const norm = Math.min(1, Math.max(0.12, energy));

                const barH = Math.max(3, norm * height * 0.92);
                const x = i * (barW + gap);
                const y = midY - barH / 2;
                const isPlayed = i / barCount <= progressRef.current;

                ctx.fillStyle = isPlayed ? accent : inactive;
                ctx.globalAlpha = isPlayed ? 1 : 0.4;

                ctx.beginPath();
                if (typeof ctx.roundRect === "function") {
                    ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 2));
                } else {
                    ctx.rect(x, y, barW, barH);
                }
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        };

        raf = requestAnimationFrame(draw);

        // Listen for media element pause/play/ended to sync instantly
        const onMediaStateChange = () => {
            if (!isMediaActuallyPlaying()) {
                if (raf) cancelAnimationFrame(raf);
                drawResting();
            } else if (!raf) {
                raf = requestAnimationFrame(draw);
            }
        };

        if (mediaElement) {
            mediaElement.addEventListener("pause", onMediaStateChange);
            mediaElement.addEventListener("ended", onMediaStateChange);
            mediaElement.addEventListener("play", onMediaStateChange);
            mediaElement.addEventListener("emptied", onMediaStateChange);
        }

        return () => {
            if (raf) cancelAnimationFrame(raf);
            if (mediaElement) {
                mediaElement.removeEventListener("pause", onMediaStateChange);
                mediaElement.removeEventListener("ended", onMediaStateChange);
                mediaElement.removeEventListener("play", onMediaStateChange);
                mediaElement.removeEventListener("emptied", onMediaStateChange);
            }
        };
    }, [isPlaying, mediaElement, width, height, barCount]);

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!onSeek || !mediaElement) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const d = mediaElement.duration;
        if (d && isFinite(d)) onSeek(ratio * d);
    };

    return (
        <canvas
            ref={canvasRef}
            onClick={handleClick}
            className={`shrink-0 ${onSeek ? "cursor-pointer" : ""}`}
            title={onSeek ? "Click to seek" : undefined}
        />
    );
}
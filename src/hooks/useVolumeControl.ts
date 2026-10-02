import { useState, useEffect, useRef } from "react";
import type { RefObject } from "react";

interface UseVolumeControlProps {
    audioRef: RefObject<HTMLAudioElement | null>;
    videoElementRef: RefObject<HTMLVideoElement | null>;
    sendIframeCommand: (cmd: string, args?: any[]) => void;
    updateSetting?: (key: string, val: any) => void;
    activeVideoPlaying?: boolean;
}

export function useVolumeControl({
    audioRef,
    videoElementRef,
    sendIframeCommand,
    updateSetting,
    activeVideoPlaying = false,
}: UseVolumeControlProps) {
    const [volume, setVolume] = useState<number>(() => {
        const saved = localStorage.getItem("devizee_volume");
        return saved !== null ? parseFloat(saved) : 0.8;
    });
    const [isMuted, setIsMuted] = useState(false);
    const volumeDebounceTimer = useRef<any>(null);

    const handleVolumeChange = (newVol: number) => {
        const clamped = Math.max(0, Math.min(1, newVol));
        setVolume(clamped);
        setIsMuted(clamped === 0);
        if (audioRef.current) audioRef.current.volume = clamped;
        if (videoElementRef.current) videoElementRef.current.volume = clamped;
        sendIframeCommand("setVolume", [Math.round(clamped * 100)]);
        if (clamped === 0) {
            sendIframeCommand("mute");
        } else {
            sendIframeCommand("unMute");
        }
        if (volumeDebounceTimer.current) clearTimeout(volumeDebounceTimer.current);
        volumeDebounceTimer.current = setTimeout(() => {
            localStorage.setItem("devizee_volume", clamped.toString());
            updateSetting?.("volume", clamped);
        }, 250);
    };

    const toggleMute = () => {
        if (isMuted) {
            setIsMuted(false);
            const restore = volume > 0 ? volume : 0.8;
            if (audioRef.current) audioRef.current.volume = restore;
            if (videoElementRef.current) videoElementRef.current.volume = restore;
            sendIframeCommand("unMute");
            sendIframeCommand("setVolume", [Math.round(restore * 100)]);
        } else {
            setIsMuted(true);
            if (audioRef.current) audioRef.current.volume = 0;
            if (videoElementRef.current) videoElementRef.current.volume = 0;
            sendIframeCommand("mute");
        }
    };

    // Sync volume to audio/video elements and iframe on state change or mount
    useEffect(() => {
        const effective = isMuted ? 0 : volume;
        if (audioRef.current) audioRef.current.volume = effective;
        if (videoElementRef.current) videoElementRef.current.volume = effective;
        sendIframeCommand("setVolume", [Math.round(effective * 100)]);
        if (isMuted || effective === 0) {
            sendIframeCommand("mute");
        } else {
            sendIframeCommand("unMute");
        }
    }, [volume, isMuted, activeVideoPlaying]);

    return {
        volume,
        setVolume,
        isMuted,
        setIsMuted,
        handleVolumeChange,
        toggleMute,
    };
}

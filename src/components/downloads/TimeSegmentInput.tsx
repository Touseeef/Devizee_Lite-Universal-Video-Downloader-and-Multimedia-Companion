import React, { useRef } from "react";
import { parseTimeToSeconds, formatSecondsToTime } from "../../lib/format";

interface TimeSegmentInputProps {
    value: string;
    onChange: (newValue: string) => void;
    maxDurationSeconds?: number | null;
    label?: string;
    minSeconds?: number;
    maxSecondsLimit?: number;
}

export const TimeSegmentInput: React.FC<TimeSegmentInputProps> = ({
    value,
    onChange,
    maxDurationSeconds,
    label,
    minSeconds = 0,
    maxSecondsLimit,
}) => {
    const totalSeconds = parseTimeToSeconds(value);
    const maxSec = maxSecondsLimit ?? (maxDurationSeconds && maxDurationSeconds > 0 ? maxDurationSeconds : 86399);
    const showHours = (maxDurationSeconds && maxDurationSeconds >= 3600) || totalSeconds >= 3600;

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hRef = useRef<HTMLInputElement>(null);
    const mRef = useRef<HTMLInputElement>(null);
    const sRef = useRef<HTMLInputElement>(null);

    const updateTime = (newH: number, newM: number, newS: number) => {
        let nextSec = Math.max(0, newH * 3600 + newM * 60 + newS);
        if (nextSec < minSeconds) nextSec = minSeconds;
        if (nextSec > maxSec) nextSec = maxSec;

        const formatted = formatSecondsToTime(nextSec, showHours);
        onChange(formatted);
    };

    const handleWheel = (segment: "h" | "m" | "s", e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        if (segment === "h") updateTime(hours + delta, minutes, seconds);
        else if (segment === "m") updateTime(hours, minutes + delta, seconds);
        else if (segment === "s") updateTime(hours, minutes, seconds + delta);
    };

    const handleKeyDown = (segment: "h" | "m" | "s", e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            if (segment === "h") updateTime(hours + 1, minutes, seconds);
            else if (segment === "m") updateTime(hours, minutes + 1, seconds);
            else if (segment === "s") updateTime(hours, minutes, seconds + 1);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (segment === "h") updateTime(hours - 1, minutes, seconds);
            else if (segment === "m") updateTime(hours, minutes - 1, seconds);
            else if (segment === "s") updateTime(hours, minutes, seconds - 1);
        } else if (e.key === "ArrowRight") {
            if (segment === "h") mRef.current?.focus();
            else if (segment === "m") sRef.current?.focus();
        } else if (e.key === "ArrowLeft") {
            if (segment === "s") mRef.current?.focus();
            else if (segment === "m" && showHours) hRef.current?.focus();
        }
    };

    const isOutOfRange = totalSeconds > maxSec || totalSeconds < minSeconds;

    return (
        <div className="flex flex-col gap-1 select-none">
            {label && <label className="text-[10px] uppercase font-bold text-tertiary">{label}</label>}
            <div
                className={`flex items-center justify-center bg-surface-1 border rounded-lg px-2 py-1 font-mono text-caption transition-colors ${
                    isOutOfRange
                        ? "border-status-danger ring-1 ring-status-danger/30 text-status-danger"
                        : "border-border-subtle focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30 text-primary"
                }`}
                title="Scroll mouse wheel or use Up/Down arrow keys to adjust"
            >
                {showHours && (
                    <>
                        <input
                            ref={hRef}
                            type="text"
                            inputMode="numeric"
                            value={hours < 10 ? `0${hours}` : `${hours}`}
                            onFocus={(e) => e.target.select()}
                            onWheel={(e) => handleWheel("h", e)}
                            onKeyDown={(e) => handleKeyDown("h", e)}
                            onChange={(e) => {
                                const val = parseInt(e.target.value.replace(/\D/g, "").slice(-2), 10);
                                updateTime(isNaN(val) ? 0 : val, minutes, seconds);
                            }}
                            className="w-6 bg-transparent text-center outline-none cursor-ns-resize hover:text-accent font-semibold"
                            maxLength={2}
                        />
                        <span className="text-tertiary font-bold mx-0.5 pointer-events-none">:</span>
                    </>
                )}

                <input
                    ref={mRef}
                    type="text"
                    inputMode="numeric"
                    value={minutes < 10 ? `0${minutes}` : `${minutes}`}
                    onFocus={(e) => e.target.select()}
                    onWheel={(e) => handleWheel("m", e)}
                    onKeyDown={(e) => handleKeyDown("m", e)}
                    onChange={(e) => {
                        const val = parseInt(e.target.value.replace(/\D/g, "").slice(-2), 10);
                        updateTime(hours, isNaN(val) ? 0 : Math.min(59, val), seconds);
                    }}
                    className="w-6 bg-transparent text-center outline-none cursor-ns-resize hover:text-accent font-semibold"
                    maxLength={2}
                />

                <span className="text-tertiary font-bold mx-0.5 pointer-events-none">:</span>

                <input
                    ref={sRef}
                    type="text"
                    inputMode="numeric"
                    value={seconds < 10 ? `0${seconds}` : `${seconds}`}
                    onFocus={(e) => e.target.select()}
                    onWheel={(e) => handleWheel("s", e)}
                    onKeyDown={(e) => handleKeyDown("s", e)}
                    onChange={(e) => {
                        const val = parseInt(e.target.value.replace(/\D/g, "").slice(-2), 10);
                        updateTime(hours, minutes, isNaN(val) ? 0 : Math.min(59, val));
                    }}
                    className="w-6 bg-transparent text-center outline-none cursor-ns-resize hover:text-accent font-semibold"
                    maxLength={2}
                />
            </div>
            {isOutOfRange && (
                <span className="text-[10px] text-status-danger font-medium">
                    Exceeds video length ({formatSecondsToTime(maxSec, showHours)})
                </span>
            )}
        </div>
    );
};

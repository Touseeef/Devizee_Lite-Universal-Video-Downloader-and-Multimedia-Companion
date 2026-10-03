// src/components/common/EqualizerDropdown.tsx
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sliders } from "lucide-react";
import { EQ_PRESETS } from "../../lib/audioContext";

export function EqualizerDropdown({
    selectedPreset,
    onSelectPreset,
    placement = "up",
    compact = false,
}: {
    selectedPreset: string;
    onSelectPreset: (presetId: string) => void;
    placement?: "up" | "down" | "right";
    compact?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleOutsideClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        if (open) document.addEventListener("mousedown", handleOutsideClick);
        return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [open]);

    const activePresetObj = selectedPreset === "custom"
        ? { id: "custom", name: "Custom", gains: [] }
        : (EQ_PRESETS.find((p) => p.id === selectedPreset) || EQ_PRESETS[0]);
    const activeLabel = activePresetObj.name;

    const panelPosition =
        placement === "up"
            ? "bottom-full mb-1.5 left-0"
            : placement === "right"
                ? "left-full ml-2 bottom-0"
                : "top-full mt-1.5 left-0";

    return (
        <div className={`relative text-left ${compact ? "inline-block w-full" : "w-full"}`} ref={dropdownRef}>
            {compact ? (
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    title={`Equalizer: ${activeLabel}`}
                    className="w-full flex items-center justify-center py-2.5 rounded-md bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary border border-border-subtle transition-colors cursor-pointer"
                >
                    <Sliders size={15} className={selectedPreset !== "flat" ? "text-accent" : "text-secondary"} />
                </button>
            ) : (
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-surface-2 hover:bg-surface-3 text-primary border border-border-subtle text-caption font-semibold transition-all shadow-xs cursor-pointer"
                    title={`Equalizer Preset: ${activeLabel}`}
                >
                    <Sliders size={14} className={selectedPreset !== "flat" ? "text-accent shrink-0" : "text-secondary shrink-0"} />
                    <span className="flex-1 text-left truncate">{activeLabel}</span>
                    <ChevronDown size={12} className="text-tertiary shrink-0" />
                </button>
            )}

            {open && (
                <div
                    className={`absolute ${panelPosition} w-60 rounded-xl bg-surface-1 border border-border-subtle shadow-floating p-1.5 z-50 animate-in fade-in zoom-in-95 duration-fast space-y-1 max-h-64 overflow-y-auto custom-scrollbar`}
                >
                    <div className="px-2 py-1 text-[10px] uppercase font-bold text-tertiary tracking-wider border-b border-border-subtle/50 mb-1 flex items-center justify-between">
                        <span>Audio Equalizer</span>
                    </div>

                    {selectedPreset === "custom" && (
                        <div className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-caption bg-accent/10 text-accent font-semibold ring-1 ring-inset ring-accent/30 mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                                <Sliders size={13} className="text-accent shrink-0" />
                                <span className="truncate">Custom (Manual)</span>
                            </div>
                            <Check size={12} className="shrink-0 text-accent" />
                        </div>
                    )}

                    {EQ_PRESETS.map((preset) => {
                        const isSelected = preset.id === selectedPreset;
                        return (
                            <button
                                key={preset.id}
                                type="button"
                                onClick={() => {
                                    onSelectPreset(preset.id);
                                    setOpen(false);
                                }}
                                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-caption transition-colors cursor-pointer ${
                                    isSelected
                                        ? "bg-accent/10 text-accent font-semibold ring-1 ring-inset ring-accent/30"
                                        : "text-primary hover:bg-surface-2"
                                }`}
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <Sliders size={13} className={isSelected ? "text-accent shrink-0" : "text-tertiary shrink-0"} />
                                    <span className="truncate">{preset.name}</span>
                                </div>
                                {isSelected && <Check size={12} className="shrink-0 text-accent" />}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

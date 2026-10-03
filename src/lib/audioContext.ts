

export const globalAudioState: { ctx: AudioContext | null } = { ctx: null };

export const EQ_FREQUENCIES = [60, 150, 400, 1000, 2400, 6000, 12000, 16000];

export type EqPreset = { id: string; name: string; gains: number[] };

export const EQ_PRESETS: EqPreset[] = [
    { id: "flat", name: "Flat (Default)", gains: [0, 0, 0, 0, 0, 0, 0, 0] },
    { id: "bass_boost", name: "Bass Boost", gains: [6, 4.5, 2, 0, 0, 0, 0, 0] },
    { id: "vocal", name: "Vocal Booster", gains: [-2, -1, 1, 3.5, 4, 2, 1, 0] },
    { id: "electronic", name: "Electronic / Dance", gains: [5, 4, 1, 0, 1.5, 3, 4, 4.5] },
    { id: "rock", name: "Rock / Metal", gains: [4.5, 3, -1, -1.5, 1, 3, 4, 4] },
    { id: "pop", name: "Pop", gains: [-1, 2, 3, 3, 2, -1, 1, 2] },
    { id: "acoustic", name: "Acoustic / Classical", gains: [3.5, 2.5, 1.5, 0, 1, 2, 3, 3.5] },
    { id: "treble", name: "Treble Boost", gains: [-2, -1, 0, 0, 1.5, 3, 5, 6] },
    { id: "movie", name: "Movie / Cinema", gains: [4, 3, 0, 1, 2, 4, 3, 2] },
];

let initialGains = [0, 0, 0, 0, 0, 0, 0, 0];
try {
    const saved = localStorage.getItem("devizee_eq_bands");
    if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 8) initialGains = parsed;
    }
} catch { }
export let currentEqGains: number[] = initialGains;

const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const elementFilterChains = new WeakMap<HTMLMediaElement, BiquadFilterNode[]>();
const allActiveFilterChains = new Set<BiquadFilterNode[]>();

export function ensureAudioContext(): AudioContext | null {
    if (!globalAudioState.ctx) {
        try {
            const Ctx = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new Ctx();

            // Bug 7 fix: auto-resume when the OS suspends the audio device
            // (sleep, Bluetooth disconnect, driver reset, USB DAC unplug).
            // Without this, the AudioContext permanently sits in "suspended"
            // state after the device returns — silent playback until restart.
            ctx.onstatechange = () => {
                if (ctx.state === "suspended") {
                    ctx.resume().catch((err) =>
                        console.warn("[Devizee EQ] onstatechange resume failed:", err)
                    );
                }
            };

            globalAudioState.ctx = ctx;
        } catch (e) {
            console.error("[Devizee EQ] Cannot create AudioContext:", e);
            return null;
        }
    }
    const ctx = globalAudioState.ctx;
    if (ctx.state === "suspended") ctx.resume().catch(() => { });
    return ctx;
}

/**
 * Attach an 8-band EQ chain to a media element.
 * IMPORTANT: must be called BEFORE the media element starts loading
 * (i.e. before setting src). Requires the element to have
 * crossOrigin="anonymous" for cross-origin (asset://) sources.
 */
export function attachEqualizerToMedia(element: HTMLMediaElement): boolean {
    if (elementFilterChains.has(element)) return true;

    const ctx = ensureAudioContext();
    if (!ctx) return false;

    try {
        // createMediaElementSource can only be called ONCE per element per context
        let source: MediaElementAudioSourceNode;
        try {
            source = ctx.createMediaElementSource(element);
        } catch (err: any) {
            // Already attached in a previous session or already routed
            console.warn("[Devizee EQ] createMediaElementSource failed:", err?.message || err);
            return false;
        }

        const filters: BiquadFilterNode[] = [];
        for (let i = 0; i < EQ_FREQUENCIES.length; i++) {
            const f = ctx.createBiquadFilter();
            f.type = "peaking";
            f.frequency.value = EQ_FREQUENCIES[i];
            f.Q.value = 1.0;
            f.gain.value = currentEqGains[i] ?? 0;
            filters.push(f);
        }

        // Chain: source → f0 → f1 → … → f7 → destination
        let node: AudioNode = source;
        for (const f of filters) {
            node.connect(f);
            node = f;
        }
        node.connect(ctx.destination);

        elementSources.set(element, source);
        elementFilterChains.set(element, filters);
        allActiveFilterChains.add(filters);

        // Clean up when the media element is removed from DOM
        const cleanup = () => {
            allActiveFilterChains.delete(filters);
        };
        element.addEventListener("emptied", cleanup, { once: true });

        console.log("[Devizee EQ] Attached 8-band EQ");
        return true;
    } catch (e) {
        console.error("[Devizee EQ] attach failed:", e);
        return false;
    }
}

/** Update gain for all 8 bands across all attached elements, in real time. */
export function setGlobalEqualizerGains(gains: number[]) {
    currentEqGains = [...gains];
    try { localStorage.setItem("devizee_eq_bands", JSON.stringify(gains)); } catch { }

    const ctx = globalAudioState.ctx;
    const now = ctx ? ctx.currentTime : 0;

    // Clean up orphaned filter chains before iterating
    const toRemove: BiquadFilterNode[][] = [];
    allActiveFilterChains.forEach((filters) => {
        try {
            filters.forEach((filter, idx) => {
                const val = gains[idx] ?? 0;
                if (ctx) {
                    filter.gain.setTargetAtTime(val, now, 0.03);
                } else {
                    filter.gain.value = val;
                }
            });
        } catch {
            // Filter chain is orphaned/disconnected — mark for removal
            toRemove.push(filters);
        }
    });
    // Remove orphaned chains
    for (const chain of toRemove) {
        allActiveFilterChains.delete(chain);
    }
}

export function applyEqualizerPreset(presetId: string): EqPreset {
    const preset = EQ_PRESETS.find((p) => p.id === presetId) || EQ_PRESETS[0];
    setGlobalEqualizerGains(preset.gains);
    try { localStorage.setItem("devizee_eq_preset", preset.id); } catch { }
    return preset;
}

/** Route audio to a specific hardware output. Element first, then context. */
export async function routeAudioDevice(deviceId: string, element?: HTMLMediaElement | null) {
    const target = deviceId === "default" || !deviceId ? "" : deviceId;

    if (element && typeof (element as any).setSinkId === "function") {
        try {
            await (element as any).setSinkId(target);
        } catch (e) {
            console.warn("[Devizee Audio] Element setSinkId failed:", e);
            if (target !== "") {
                try { await (element as any).setSinkId(""); } catch { }
            }
        }
    }

    if (globalAudioState.ctx && typeof (globalAudioState.ctx as any).setSinkId === "function") {
        try {
            await (globalAudioState.ctx as any).setSinkId(target);
        } catch (e) {
            console.warn("[Devizee Audio] Context setSinkId failed:", e);
        }
    }
}
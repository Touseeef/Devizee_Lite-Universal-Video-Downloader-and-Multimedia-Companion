// src/lib/status.ts
//
// Mirrors src-tauri/src/status.rs exactly (snake_case tags to match serde).
// The exhaustiveCheck function below makes the TS compiler fail the build
// if a status is ever added to one side and not the other — don't remove it.

export type TaskStatus =
  | "queued"
  | "starting"
  | "fetching_metadata"
  | "downloading"
  | "muxing"
  | "verifying"
  | "completed"
  | "error"
  | "cancelled"
  | "interrupted"
  | "missing";

export type ErrorCode =
  | "network"
  | "age_restricted"
  | "unavailable"
  | "disk_full"
  | "verification_failed"
  | "spawn_failed"
  | "unknown";

export interface ProgressEvent {
  taskId: string;
  status: TaskStatus;
  percent?: number;      // only meaningful when status === "downloading"
  speed?: string;
  eta?: string;
  errorCode?: ErrorCode; // only present when status === "error"
}

export interface StatusDisplay {
  label: string;
  /** Design-system color token name (see design-system skill), not a raw hex/Tailwind class. */
  colorToken:
  | "accent"
  | "status-success"
  | "status-warning"
  | "status-danger"
  | "text-tertiary";
  /** How the progress bar should render for this status. */
  progressMode: "determinate" | "indeterminate" | "hidden";
  isTerminal: boolean;
}

// Exhaustive by construction: TypeScript errors here if a TaskStatus case
// is missing, and errors at every call site if a status isn't in this map.
export const STATUS_DISPLAY: Record<TaskStatus, StatusDisplay> = {
  queued: {
    label: "Queued",
    colorToken: "text-tertiary",
    progressMode: "hidden",
    isTerminal: false,
  },
  starting: {
    label: "Starting…",
    colorToken: "accent",
    progressMode: "indeterminate",
    isTerminal: false,
  },
  fetching_metadata: {
    label: "Analyzing…",
    colorToken: "accent",
    progressMode: "indeterminate",
    isTerminal: false,
  },
  downloading: {
    label: "Downloading",
    colorToken: "accent",
    progressMode: "determinate",
    isTerminal: false,
  },
  muxing: {
    label: "Finalizing…",
    colorToken: "accent",
    progressMode: "indeterminate",
    isTerminal: false,
  },
  verifying: {
    label: "Verifying…",
    colorToken: "accent",
    progressMode: "indeterminate",
    isTerminal: false,
  },
  completed: {
    label: "Completed",
    colorToken: "status-success",
    progressMode: "determinate", // stays full
    isTerminal: true,
  },
  error: {
    label: "Failed",
    colorToken: "status-danger",
    progressMode: "hidden",
    isTerminal: true,
  },
  cancelled: {
    label: "Cancelled",
    colorToken: "status-warning",
    progressMode: "hidden",
    isTerminal: true,
  },
  interrupted: {
    label: "Paused",
    colorToken: "status-warning",
    progressMode: "hidden",
    isTerminal: false,
  },
  missing: {
    label: "File missing",
    colorToken: "text-tertiary",
    progressMode: "hidden",
    isTerminal: true,
  },
};

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  network: "Connection dropped. Check your internet and try again.",
  age_restricted: "This video is age-restricted. Sign-in cookies are required — see Settings > Advanced.",
  unavailable: "This video is private, deleted, or unavailable.",
  disk_full: "Not enough disk space to complete this download.",
  verification_failed: "The downloaded file failed an integrity check and was discarded. Try again.",
  spawn_failed: "Devizee's download engine failed to start. Try restarting the app.",
  unknown: "Something went wrong. Try again, or check View Log for details.",
};

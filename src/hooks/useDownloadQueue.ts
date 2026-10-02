import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadRecord } from "../types";

export interface UseDownloadQueueOptions {
  history: DownloadRecord[];
  loadHistory: () => Promise<void>;
  handleRetryDownload: (record: DownloadRecord) => void;
  userPausedTaskIds: React.MutableRefObject<Set<string>>;
}

export function useDownloadQueue({
  history,
  loadHistory,
  handleRetryDownload,
  userPausedTaskIds,
}: UseDownloadQueueOptions) {
  const [selectedHistoryItems, setSelectedHistoryItems] = useState<Set<string>>(new Set());

  const activeCount = useMemo(
    () => history.filter((h) => h.status === "downloading" || h.status === "muxing" || h.status === "starting").length,
    [history]
  );

  const queuedCount = useMemo(
    () => history.filter((h) => h.status === "queued" || h.status === "fetching_metadata").length,
    [history]
  );

  const attentionCount = useMemo(
    () => history.filter((h) => h.status === "error" || h.status === "interrupted").length,
    [history]
  );

  const completedCount = useMemo(
    () => history.filter((h) => h.status === "completed").length,
    [history]
  );

  const firstActiveDownload = useMemo(
    () => history.find((h) => h.status === "downloading" || h.status === "starting" || h.status === "muxing") || null,
    [history]
  );

  const handlePauseDownload = async (taskId: string) => {
    userPausedTaskIds.current.add(taskId);
    try {
      await invoke("pause_download", { taskId });
    } catch (err) {
      console.error("Pause failed:", err);
    }
    loadHistory();
  };

  const handleCancelDownload = async (taskId: string) => {
    try {
      await invoke("cancel_download", { taskId });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
    loadHistory();
  };

  const handlePauseAll = async () => {
    for (const h of history) {
      if (
        h.status === "downloading" ||
        h.status === "starting" ||
        h.status === "fetching_metadata" ||
        h.status === "muxing"
      ) {
        userPausedTaskIds.current.add(h.id);
        try {
          await invoke("pause_download", { taskId: h.id });
        } catch {}
      }
    }
    loadHistory();
  };

  const handleResumeAll = async () => {
    for (const h of history) {
      if (h.status === "interrupted" || h.status === "error") {
        handleRetryDownload(h);
      }
    }
  };

  const handleCancelAll = async () => {
    for (const h of history) {
      if (
        h.status === "downloading" ||
        h.status === "starting" ||
        h.status === "queued" ||
        h.status === "interrupted"
      ) {
        try {
          await invoke("cancel_download", { taskId: h.id });
        } catch {}
      }
    }
    loadHistory();
  };

  const handlePauseSelected = async () => {
    for (const id of selectedHistoryItems) {
      const rec = history.find((h) => h.id === id);
      if (
        rec &&
        (rec.status === "downloading" ||
          rec.status === "starting" ||
          rec.status === "fetching_metadata" ||
          rec.status === "muxing")
      ) {
        userPausedTaskIds.current.add(id);
        try {
          await invoke("pause_download", { taskId: id });
        } catch {}
      }
    }
    loadHistory();
  };

  const handleResumeSelected = async () => {
    for (const id of selectedHistoryItems) {
      const rec = history.find((h) => h.id === id);
      if (rec && (rec.status === "interrupted" || rec.status === "error")) {
        handleRetryDownload(rec);
      }
    }
  };

  const handleCancelSelected = async () => {
    for (const id of selectedHistoryItems) {
      const rec = history.find((h) => h.id === id);
      if (
        rec &&
        (rec.status === "downloading" ||
          rec.status === "starting" ||
          rec.status === "queued" ||
          rec.status === "interrupted")
      ) {
        try {
          await invoke("cancel_download", { taskId: id });
        } catch {}
      }
    }
    setSelectedHistoryItems(new Set());
    loadHistory();
  };

  const handleRemoveSelected = async () => {
    for (const id of selectedHistoryItems) {
      try {
        await invoke("remove_history_record", { id });
      } catch {}
    }
    setSelectedHistoryItems(new Set());
    loadHistory();
  };

  const handleDeleteSelected = async () => {
    for (const id of selectedHistoryItems) {
      const rec = history.find((h) => h.id === id);
      if (rec) {
        try {
          if (rec.file_path) {
            await invoke("delete_file_and_record", { id: rec.id, filePath: rec.file_path });
          } else {
            await invoke("remove_history_record", { id: rec.id });
          }
        } catch {}
      }
    }
    setSelectedHistoryItems(new Set());
    loadHistory();
  };

  return {
    selectedHistoryItems,
    setSelectedHistoryItems,
    activeCount,
    queuedCount,
    attentionCount,
    completedCount,
    firstActiveDownload,
    handlePauseDownload,
    handleCancelDownload,
    handlePauseAll,
    handleResumeAll,
    handleCancelAll,
    handlePauseSelected,
    handleResumeSelected,
    handleCancelSelected,
    handleRemoveSelected,
    handleDeleteSelected,
  };
}

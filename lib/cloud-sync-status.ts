export const cloudSyncStatusLabels = {
  zh: {
    ready: "就绪",
    pending: "仅本地保存，待同步",
    syncing: "正在同步",
    synced: "云端已同步",
    error: "同步失败（点击重试）"
  },
  en: {
    ready: "Ready",
    pending: "Saved locally, pending sync",
    syncing: "Syncing",
    synced: "Synced to cloud",
    error: "Sync failed (click to retry)"
  }
} as const;

export const cloudSyncHints = {
  zh: "先写在本机，停止输入 1 秒后同步到云端",
  en: "Stored on this device first, then synced to the cloud 1 second after you stop typing"
} as const;

export type CloudSyncStatus = keyof typeof cloudSyncStatusLabels.zh;

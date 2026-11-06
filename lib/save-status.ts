export type PersistenceStatus = "pending" | "synced" | "error";

type PersistenceOperations = {
  saveLocal: () => boolean;
  saveRemote: () => Promise<void>;
  reportRemoteError: (error: unknown) => void;
  /** False when the response is stale or was not a confirmed cloud ack. */
  acceptRemote?: () => boolean;
};

export const persistWithLocalFallback = async ({
  saveLocal,
  saveRemote,
  reportRemoteError,
  acceptRemote
}: PersistenceOperations): Promise<PersistenceStatus> => {
  const savedLocally = saveLocal();

  try {
    await saveRemote();
    const accepted = acceptRemote ? acceptRemote() : true;
    if (!accepted) return savedLocally ? "pending" : "error";
    return savedLocally ? "synced" : "error";
  } catch (error) {
    reportRemoteError(error);
    return "error";
  }
};

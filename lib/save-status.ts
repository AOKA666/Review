export type PersistenceStatus = "saved" | "error";

type PersistenceOperations = {
  saveLocal: () => boolean;
  saveRemote: () => Promise<void>;
  reportRemoteError: (error: unknown) => void;
};

export const persistWithLocalFallback = async ({
  saveLocal,
  saveRemote,
  reportRemoteError
}: PersistenceOperations): Promise<PersistenceStatus> => {
  const savedLocally = saveLocal();

  try {
    await saveRemote();
    return savedLocally ? "saved" : "error";
  } catch (error) {
    reportRemoteError(error);
    return "error";
  }
};

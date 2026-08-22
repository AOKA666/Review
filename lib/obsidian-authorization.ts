export type ObsidianAuthorizationDependencies<Handle> = {
  pick: () => Promise<Handle>;
  hasPermission: (handle: Handle) => Promise<boolean>;
  requestPermission: (handle: Handle) => Promise<boolean>;
  save: (handle: Handle) => Promise<void>;
};

export const authorizeObsidianDirectory = async <Handle>(
  savedHandle: Handle | null,
  dependencies: ObsidianAuthorizationDependencies<Handle>
): Promise<Handle | null> => {
  const handle = savedHandle ?? await dependencies.pick();
  const isAuthorized = await dependencies.hasPermission(handle)
    || await dependencies.requestPermission(handle);
  if (!isAuthorized) return null;
  await dependencies.save(handle);
  return handle;
};

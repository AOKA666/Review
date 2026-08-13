export type ObsidianAuthorizationDependencies<Handle> = {
  pick: () => Promise<Handle>;
  requestPermission: (handle: Handle) => Promise<boolean>;
  save: (handle: Handle) => Promise<void>;
};

export const authorizeObsidianDirectory = async <Handle>(
  savedHandle: Handle | null,
  dependencies: ObsidianAuthorizationDependencies<Handle>
): Promise<Handle | null> => {
  const handle = savedHandle ?? await dependencies.pick();
  if (!(await dependencies.requestPermission(handle))) return null;
  await dependencies.save(handle);
  return handle;
};

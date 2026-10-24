export interface ComposeService {
  name: string;
  ports: string[];
  build?: {
    context?: string;
    dockerfile?: string;
    /** `dockerfile_inline` is set: there is no Dockerfile on disk to sync. */
    inline?: boolean;
  };
  envFile?: string[];
  /** Fixed `container_name` — breaks running the same stack twice. */
  containerName?: string;
  /** Absolute path of the compose file that declared this service. */
  sourcePath: string;
}

/**
 * A top-level volume or network that is NOT scoped to the compose project:
 * it sets an explicit `name:` or is `external`. Every worktree stack would
 * share it.
 */
export interface SharedResource {
  /** Key under `volumes:` / `networks:`. */
  key: string;
  /** Explicit `name:` when set. */
  name?: string;
  external: boolean;
}

export interface ComposeFile {
  services: ComposeService[];
  /** Resolved absolute path of the root compose file. */
  composePath: string;
  /** Absolute paths of the root file plus all transitively-included files, root first. */
  sourceFiles: string[];
  /** Top-level volumes with a fixed name or `external`. */
  sharedVolumes: SharedResource[];
  /** Top-level networks with a fixed name or `external`. */
  sharedNetworks: SharedResource[];
}

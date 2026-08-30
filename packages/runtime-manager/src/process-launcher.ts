import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ProcessLaunchRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ProcessLaunchReceipt {
  pid: number;
  command: string;
  startedAt: string;
}

export interface ProcessLauncher {
  launch(request: ProcessLaunchRequest): Promise<ProcessLaunchReceipt>;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;
type ResolveRealPath = (path: string) => Promise<string>;

export interface DetachedProcessLauncherOptions {
  spawn?: SpawnProcess;
  realpath?: ResolveRealPath;
  now?: () => Date;
}

export class DetachedProcessLauncher implements ProcessLauncher {
  readonly #spawn: SpawnProcess;
  readonly #realpath: ResolveRealPath;
  readonly #now: () => Date;

  constructor(options: DetachedProcessLauncherOptions = {}) {
    this.#spawn = options.spawn ?? spawn;
    this.#realpath = options.realpath ?? realpath;
    this.#now = options.now ?? (() => new Date());
  }

  async launch(request: ProcessLaunchRequest): Promise<ProcessLaunchReceipt> {
    if (!isAbsolute(request.command) || !isAbsolute(request.cwd)) {
      throw new Error("runtime executable and working directory must be absolute");
    }
    const command = await this.#realpath(resolve(request.command));
    const cwd = await this.#realpath(resolve(request.cwd));

    const child = this.#spawn(command, request.args, {
      cwd,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: request.env ?? {}
    });

    const pid = await new Promise<number>((resolvePid, reject) => {
      child.once("spawn", () => {
        if (child.pid === undefined) {
          reject(new Error("runtime process started without a process identifier"));
          return;
        }
        resolvePid(child.pid);
      });
      child.once("error", reject);
    });
    child.unref();

    return { pid, command, startedAt: this.#now().toISOString() };
  }
}

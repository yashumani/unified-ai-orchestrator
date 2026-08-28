import { spawn } from "node:child_process";
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

export class DetachedProcessLauncher implements ProcessLauncher {
  async launch(request: ProcessLaunchRequest): Promise<ProcessLaunchReceipt> {
    if (!isAbsolute(request.command) || !isAbsolute(request.cwd)) {
      throw new Error("runtime executable and working directory must be absolute");
    }
    const command = await realpath(resolve(request.command));
    const cwd = await realpath(resolve(request.cwd));

    const child = spawn(command, request.args, {
      cwd,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: request.env ?? process.env
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

    return { pid, command, startedAt: new Date().toISOString() };
  }
}

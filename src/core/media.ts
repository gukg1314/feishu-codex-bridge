import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type LarkCommand = {
  cliPath: string;
  profile: string;
};

export async function runLarkCli(
  command: LarkCommand,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return await new Promise<string>((resolveResult, reject) => {
    const child = spawn(command.cliPath, ["--profile", command.profile, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveResult(stdout);
      else reject(new Error(`lark-cli 执行失败（退出码 ${code ?? "unknown"}${errorType(stderr)}）`));
    });
  });
}

function errorType(stderr: string): string {
  for (const line of stderr.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { error?: { type?: string; subtype?: string } };
      const kind = parsed.error?.subtype ?? parsed.error?.type;
      if (kind && /^[\w.-]+$/.test(kind)) return `，${kind}`;
    } catch {
      // CLI diagnostics are intentionally not copied into app logs.
    }
  }
  return "";
}

export async function runLarkCliWithData(
  command: LarkCommand,
  payload: Record<string, unknown>,
  args: (file: string) => string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feishu-codex-card-"));
  try {
    await writeFile(join(directory, "payload.json"), JSON.stringify(payload), { mode: 0o600 });
    return await runLarkCli(command, args("@payload.json"), { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function sendLarkMedia(
  command: LarkCommand,
  chatId: string,
  kind: "image" | "file",
  localPath: string,
): Promise<void> {
  const path = resolve(localPath);
  await runLarkCli(command, [
    "im", "+messages-send", "--chat-id", chatId,
    kind === "image" ? "--image" : "--file", `./${basename(path)}`,
    "--as", "bot", "--json",
  ], { cwd: dirname(path), timeoutMs: 120_000 });
}

export async function sendLarkText(command: LarkCommand, chatId: string, value: string): Promise<void> {
  await runLarkCli(command, [
    "im", "+messages-send", "--chat-id", chatId,
    "--markdown", value,
    "--as", "bot", "--json",
  ]);
}

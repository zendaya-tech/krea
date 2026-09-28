import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/start";

/**
 * The `krea` command (published on npm):
 *   krea start [project.krea] [--port 3001] [--host localhost] [--no-open]
 *   krea skill install [--agent claude|codex|all] [--dir <path>] [--force]
 *   krea skill path
 *   krea --version | --help
 */

function findPackageRoot(from: string): string {
  let dir = from;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot locate the krea package root.");
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const UI_DIR = path.join(PACKAGE_ROOT, "dist", "client");
const SKILL_SOURCE = path.join(PACKAGE_ROOT, "skills", "krea");
const VERSION: string = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")).version;

const HELP = `krea ${VERSION} — 2D and 3D map editor for video games, with an API for AI agents

Usage:
  krea start [project.krea] [options]   Start the editor and open it in your browser
      --port <n>        Port to use (default 3001; the next free one if taken)
      --host <name>     Interface to bind (default localhost)
      --no-open         Don't open the browser

  krea skill install [options]          Install the Krea skill for AI coding agents
      --agent <name>    claude, codex, or all (default all)
      --dir <path>      Install into <path>/krea instead (any skills folder)
      --force           Replace an already installed copy
  krea skill path                       Print where the skill's source files are

  krea --version
  krea --help
`;

function fail(message: string): never {
  console.error(`krea: ${message}`);
  process.exit(1);
}

/** Splits argv into positionals and --flags (a flag takes the next token as its value unless it's boolean). */
function parseArgs(argv: string[], booleans: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (booleans.includes(name)) flags[name] = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value.`);
      flags[name] = value;
      i++;
    }
  }
  return { positionals, flags };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

async function start(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv, ["no-open"]);
  if (!fs.existsSync(path.join(UI_DIR, "index.html"))) {
    fail(`the editor UI isn't built (${UI_DIR} is missing). From a source checkout, run "npm run build" first.`);
  }
  const port = flags.port === undefined ? 3001 : Number(flags.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`invalid --port "${flags.port}".`);
  const host = typeof flags.host === "string" ? flags.host : "localhost";

  let projectPath: string | null = null;
  if (positionals[0]) {
    projectPath = path.resolve(positionals[0]);
    if (!fs.existsSync(projectPath)) fail(`"${projectPath}" doesn't exist.`);
  }

  const { url } = await startServer({ port, host, staticDir: UI_DIR, portRetries: 10 }).catch((e: Error) => fail(e.message));
  const openUrl = projectPath ? `${url}/?open=${encodeURIComponent(projectPath)}` : url;

  console.log(`\n  Krea ${VERSION} is running at ${url}`);
  if (projectPath) console.log(`  Opening ${projectPath}`);
  console.log(`  AI agent API: ${url}/api/agent/openapi.json`);
  console.log("  Press Ctrl+C to stop.\n");
  if (!flags["no-open"]) openBrowser(openUrl);
}

function skillTargets(flags: Record<string, string | true>): string[] {
  if (typeof flags.dir === "string") return [path.join(path.resolve(flags.dir), "krea")];
  const agent = typeof flags.agent === "string" ? flags.agent : "all";
  const home = os.homedir();
  const claude = path.join(home, ".claude", "skills", "krea");
  const codex = path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "skills", "krea");
  if (agent === "claude") return [claude];
  if (agent === "codex") return [codex];
  if (agent === "all") return [claude, codex];
  return fail(`unknown --agent "${agent}" (expected claude, codex, or all).`);
}

function skill(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub === "path") {
    console.log(SKILL_SOURCE);
    return;
  }
  if (sub !== "install") fail('expected "krea skill install" or "krea skill path".');
  if (!fs.existsSync(path.join(SKILL_SOURCE, "SKILL.md"))) fail(`skill files not found at ${SKILL_SOURCE}.`);

  const { flags } = parseArgs(rest, ["force"]);
  for (const target of skillTargets(flags)) {
    if (fs.existsSync(target) && !flags.force) {
      console.log(`  Already installed: ${target} (use --force to replace it)`);
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(SKILL_SOURCE, target, { recursive: true });
    console.log(`  Installed the Krea skill: ${target}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "start":
      return start(rest);
    case "skill":
      return skill(rest);
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`unknown command "${command}". Run "krea --help".`);
  }
}

await main();

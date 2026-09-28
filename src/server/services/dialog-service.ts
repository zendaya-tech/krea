import { spawn } from "node:child_process";
import os from "node:os";

/**
 * Native OS dialogs, opened by the server on the machine it runs on. A
 * browser page can never recover a real filesystem path from its own
 * pickers — this only works because this is a local tool whose server has
 * direct OS access. Nothing user-supplied is interpolated into a command:
 * the only dynamic value (a default file name) is passed via environment
 * variable / argv.
 */

function runCommand(cmd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && out.trim() === "") {
        reject(new Error(err.trim() || `Exited with code ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

async function runPowerShell(script: string, env?: Record<string, string>): Promise<string | null> {
  const out = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], env);
  return out || null;
}

/** Runs a command where a non-zero exit just means "cancelled" (macOS/Linux dialogs). */
async function cancellable(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await runCommand(cmd, args)) || null;
  } catch {
    return null;
  }
}

export async function pickFolderNative(): Promise<string | null> {
  const platform = os.platform();
  if (platform === "win32") {
    return runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "Select a folder"
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`);
  }
  if (platform === "darwin") return cancellable("osascript", ["-e", "POSIX path of (choose folder)"]);
  return (await cancellable("zenity", ["--file-selection", "--directory"])) ?? cancellable("kdialog", ["--getexistingdirectory"]);
}

/** Open-file dialog filtered to .krea projects (plus legacy map.json). */
export async function pickProjectToOpen(): Promise<string | null> {
  const platform = os.platform();
  if (platform === "win32") {
    return runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = "Open a Krea project"
$d.Filter = "Krea project (*.krea)|*.krea|Legacy map (map.json)|map.json|All files (*.*)|*.*"
$d.CheckFileExists = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`);
  }
  if (platform === "darwin") {
    return cancellable("osascript", ["-e", 'POSIX path of (choose file with prompt "Open a Krea project")']);
  }
  return (
    (await cancellable("zenity", ["--file-selection", "--title=Open a Krea project", "--file-filter=Krea project | *.krea", "--file-filter=All files | *"])) ??
    cancellable("kdialog", ["--getopenfilename", ".", "*.krea"])
  );
}

/** Save-file dialog for choosing where a new .krea project goes. */
export async function pickProjectToSave(defaultName: string): Promise<string | null> {
  const safeName = defaultName.replace(/[^a-zA-Z0-9 _-]+/g, "").trim() || "project";
  const platform = os.platform();
  if (platform === "win32") {
    return runPowerShell(
      `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = "Create a Krea project"
$d.Filter = "Krea project (*.krea)|*.krea"
$d.DefaultExt = "krea"
$d.AddExtension = $true
$d.OverwritePrompt = $true
$d.FileName = $env:KREA_DEFAULT_NAME
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`,
      { KREA_DEFAULT_NAME: `${safeName}.krea` },
    );
  }
  if (platform === "darwin") {
    return cancellable("osascript", [
      "-e",
      "on run argv",
      "-e",
      'POSIX path of (choose file name with prompt "Create a Krea project" default name (item 1 of argv))',
      "-e",
      "end run",
      `${safeName}.krea`,
    ]);
  }
  return (
    (await cancellable("zenity", ["--file-selection", "--save", "--confirm-overwrite", `--filename=${safeName}.krea`, "--file-filter=Krea project | *.krea"])) ??
    cancellable("kdialog", ["--getsavefilename", `${safeName}.krea`, "*.krea"])
  );
}

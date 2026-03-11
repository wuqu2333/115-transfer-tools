import { Router } from "express";
import os from "os";
import { execFile } from "child_process";
import { ok, fail } from "../helpers";

function escapePsString(value: string) {
  return (value || "").replace(/'/g, "''");
}

function selectDirectoryWindows(title: string): Promise<string> {
  const desc = escapePsString(title || "Choose folder");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$f.Description = '${desc}'`,
    "$f.ShowNewFolderButton = $true",
    "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }",
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const out = (stdout || "").trim();
      if (!out) return reject(new Error("\u672a\u9009\u62e9\u76ee\u5f55"));
      resolve(out);
    });
  });
}

export const router = Router();

router.post("/system/select-directory", async (req, res) => {
  try {
    if (os.platform() !== "win32") return fail(res, 400, "\u4ec5\u652f\u6301 Windows \u9009\u62e9\u76ee\u5f55");
    const title = req.body?.title || "\u9009\u62e9\u76ee\u5f55";
    const path = await selectDirectoryWindows(title);
    ok(res, { path });
  } catch (e: any) {
    fail(res, 400, e.message || "\u9009\u62e9\u76ee\u5f55\u5931\u8d25", e.message);
  }
});

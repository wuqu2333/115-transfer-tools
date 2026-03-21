import os from "os";
import { execFile } from "child_process";
import { resolve, parse } from "path";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function getDriveLetter(targetPath: string) {
  const full = resolve(targetPath || ".");
  const root = parse(full).root || "";
  if (!root) return "";
  return root.replace(/\\$/, "");
}

export async function getDiskInfo(targetPath: string) {
  if (os.platform() !== "win32") return null;
  const drive = getDriveLetter(targetPath);
  if (!drive) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='${drive}'\"`,
    "$d | Select-Object Size,FreeSpace | ConvertTo-Json -Compress",
  ].join("; ");

  const stdout = await new Promise<string>((resolvePromise, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 20000 }, (err, out, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolvePromise(String(out || "").trim());
    });
  });
  if (!stdout) return null;
  let data: any = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const total = Number(data?.Size || 0);
  const free = Number(data?.FreeSpace || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const used = Math.max(total - (Number.isFinite(free) ? free : 0), 0);
  return { total, free: Number.isFinite(free) ? free : null, used };
}

function snapshotCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export async function getCpuUsagePercent(sampleMs = 200) {
  const a = snapshotCpu();
  await sleep(sampleMs);
  const b = snapshotCpu();
  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  const usage = Math.round(((total - idle) / total) * 100);
  return Math.max(0, Math.min(100, usage));
}

export async function clearRecycleBin() {
  if (os.platform() !== "win32") return;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Clear-RecycleBin -Force",
  ].join("; ");
  await new Promise<void>((resolvePromise, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 20000 }, (err, _out, _err) => {
      if (err) return reject(err);
      resolvePromise();
    });
  });
}

import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MAX_VISION_WIDTH = 1280;
const MAC_SCREEN_CAPTURE = "/usr/sbin/screencapture";
const MAC_SIPS = "/usr/bin/sips";
const MAC_SWIFT = "/usr/bin/swift";

const JACKBOX_WINDOW_SCRIPT = String.raw`
import CoreGraphics
import Foundation

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  exit(1)
}

let candidates = windows.compactMap { window -> (number: Int, area: Double)? in
  guard
    let owner = window[kCGWindowOwnerName as String] as? String,
    owner.localizedCaseInsensitiveContains("Jackbox"),
    let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue,
    let bounds = window[kCGWindowBounds as String] as? [String: Any],
    let width = (bounds["Width"] as? NSNumber)?.doubleValue,
    let height = (bounds["Height"] as? NSNumber)?.doubleValue
  else { return nil }

  let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
  guard layer == 0, width > 0, height > 0 else { return nil }
  return (number, width * height)
}

guard let window = candidates.max(by: { $0.area < $1.area }) else { exit(2) }
print(window.number)
`;

// Windows stub: this captures and scales the primary display. A production VM
// can later replace this with Jackbox-process window selection without changing
// captureScreen's interface.
const WINDOWS_CAPTURE_SCRIPT = String.raw`
param([string]$OutputPath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$source = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($source)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
} finally {
  $graphics.Dispose()
}

$width = [Math]::Min(${MAX_VISION_WIDTH}, $bounds.Width)
$height = [Math]::Max(1, [Math]::Round($bounds.Height * $width / $bounds.Width))
if ($width -eq $bounds.Width) {
  $source.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  $scaled = New-Object System.Drawing.Bitmap $width, $height
  $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
  try {
    $scaledGraphics.DrawImage($source, 0, 0, $width, $height)
    $scaled.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $scaledGraphics.Dispose()
    $scaled.Dispose()
  }
}
$source.Dispose()
`;

interface CommandResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeout = 15_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function jackboxWindowNumber(): Promise<string | undefined> {
  try {
    const { stdout } = await run(MAC_SWIFT, ["-e", JACKBOX_WINDOW_SCRIPT], 5_000);
    const windowNumber = stdout.trim();
    return /^\d+$/.test(windowNumber) ? windowNumber : undefined;
  } catch {
    return undefined;
  }
}

/** Downscale a macOS PNG in place so vision requests are at most 1280px wide. */
export async function downscaleForVision(path: string, maxWidth = MAX_VISION_WIDTH): Promise<void> {
  if (process.platform !== "darwin") return;
  const { stdout } = await run(MAC_SIPS, ["-g", "pixelWidth", path]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(width)) throw new Error(`Could not read image width from sips for ${path}`);
  if (width > maxWidth) {
    await run(MAC_SIPS, ["--resampleWidth", String(maxWidth), path]);
  }
}

/** Copy a supplied test/sandbox image before applying the same vision downscale. */
export async function prepareImageForVision(inputPath: string, outputPath: string): Promise<string> {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(input, output);
  await downscaleForVision(output);
  return output;
}

/** Capture the current display to a PNG and return its absolute path. */
export async function captureScreen(outputPath: string): Promise<string> {
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });

  if (process.platform === "darwin") {
    const windowNumber = await jackboxWindowNumber();
    let capturedWindow = false;
    if (windowNumber) {
      try {
        await run(MAC_SCREEN_CAPTURE, ["-x", "-l", windowNumber, output]);
        capturedWindow = true;
      } catch {
        // Window IDs can disappear between enumeration and capture.
      }
    }
    if (!capturedWindow) await run(MAC_SCREEN_CAPTURE, ["-x", output]);
    await downscaleForVision(output);
    return output;
  }

  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_CAPTURE_SCRIPT,
      output,
    ]);
    return output;
  }

  throw new Error(`Screen capture is not implemented for ${process.platform}; use --image PATH`);
}

import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import fs from 'node:fs';
import path from 'node:path';

// Auth-gated APK download.
//
// We do NOT serve the APK from /public/ — anything in /public/ is publicly
// fetchable, which would let randos hot-link the binary, skew our download
// counts, and (worst) ship a bypassed binary if we ever decide to put
// per-user telemetry into the APK build later.
//
// This route reads the APK from disk OUTSIDE the Next.js bundle
// (apk-releases/ at the project root — see .gitignore for which files are
// tracked) and streams it to the browser only after JWT cookie verification.
// Anonymous requests get 401.
//
// Filename + version are surfaced via the X-CC-Apk-Version header so the
// /app/settings UI can show "you're downloading vN".
//
// Versioning: instead of hardcoding the filename, we scan apk-releases/ at
// request time and pick the highest `computercaller-v<N>.apk` we find. The
// strict regex (no hyphens between `v<digits>` and `.apk`) deliberately
// excludes Play Store `.aab` bundles and bisect builds like
// `computercaller-v14a-bisect-noreuseaddr.apk`. Adding a new release is a
// drop-the-file-and-update-.gitignore operation — no code edit here.

const APK_DIR = 'apk-releases';
const APK_PATTERN = /^computercaller-v(\d+)\.apk$/;

type ApkEntry = { filename: string; version: number };

function findLatestApk(dirAbsPath: string): ApkEntry | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirAbsPath);
  } catch (err) {
    console.error('[apk download] readdir failed:', dirAbsPath, err);
    return null;
  }

  let best: ApkEntry | null = null;
  for (const name of entries) {
    const match = APK_PATTERN.exec(name);
    if (!match) continue;
    const version = Number.parseInt(match[1], 10);
    if (!Number.isFinite(version)) continue;
    if (!best || version > best.version) {
      best = { filename: name, version };
    }
  }
  return best;
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  // Bundle B M10 fix — was verifyAccessToken (signature-only). Switched to
  // validateSessionToken so a kicked session (sessionVersion bumped by a fresh
  // login elsewhere) is rejected here too. Matches /api/auth/me's pattern.
  const payload = await validateSessionToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  // process.cwd() in Next.js standalone / dev is the project root.
  const apkDirAbs = path.join(process.cwd(), APK_DIR);
  const latest = findLatestApk(apkDirAbs);

  if (!latest) {
    // Directory missing or no matching files. Surface a 503 — this is the
    // "deploy box doesn't have apk-releases/ mounted" failure mode, or the
    // .gitignore exception didn't include the file we expected.
    console.error('[apk download] no APK found in:', apkDirAbs);
    return NextResponse.json(
      { error: 'APK temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    );
  }

  const apkPath = path.join(apkDirAbs, latest.filename);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(apkPath);
  } catch (err) {
    console.error('[apk download] stat failed:', apkPath, err);
    return NextResponse.json(
      { error: 'APK temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    );
  }

  // Stream via a ReadableStream so we don't load the full ~6MB into memory
  // for every download. fs.createReadStream → web-ReadableStream conversion
  // is built into modern Node and Next.
  const nodeStream = fs.createReadStream(apkPath);
  // Node's Readable.toWeb is available on Node >= 17 / 18. The project
  // already requires Node 20+ via Next 15.
  const { Readable } = await import('node:stream');
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${latest.filename}"`,
      'X-CC-Apk-Version': String(latest.version),
      'Cache-Control': 'private, no-store',
    },
  });
}

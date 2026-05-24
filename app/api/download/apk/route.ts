import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth';
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
// (apk-releases/ at the project root, gitignored) and streams it to the
// browser only after JWT cookie verification. Anonymous requests get 401.
//
// Filename + version are surfaced via the X-CC-Apk-Version header so the
// /app/settings UI can show "you're downloading vN.N.N".

const APK_FILENAME = 'computercaller-v12.apk';
const APK_VERSION = '1.0.0';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  // process.cwd() in Next.js standalone / dev is the project root.
  const apkPath = path.join(process.cwd(), 'apk-releases', APK_FILENAME);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(apkPath);
  } catch {
    // APK isn't on disk — surface a meaningful 503 instead of a generic 500.
    // This is the "deploy box doesn't have apk-releases/ mounted" failure mode.
    console.error('[apk download] missing file:', apkPath);
    return NextResponse.json(
      { error: 'APK temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    );
  }

  // Stream via a ReadableStream so we don't load the full 5MB into memory
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
      'Content-Disposition': `attachment; filename="${APK_FILENAME}"`,
      'X-CC-Apk-Version': APK_VERSION,
      'Cache-Control': 'private, no-store',
    },
  });
}

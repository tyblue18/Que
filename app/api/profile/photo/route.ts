import { put }              from '@vercel/blob';
import { getServerSession } from 'next-auth/next';
import { NextResponse }     from 'next/server';
import { authOptions }      from '@/lib/auth';
import { prisma }           from '@/lib/prisma';
import { photoLimit }       from '@/lib/ratelimit';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Detect image type from the first few bytes (magic numbers). The client-supplied
 * `file.type` can be spoofed, so we verify the actual content. Returns null if the
 * bytes don't match any allowed image format.
 */
function detectImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return 'image/png';
  // WebP: 'RIFF' .... 'WEBP'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 });

  const { success } = await photoLimit.limit(session.user.id);
  if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const form = await req.formData();
  const file = form.get('photo') as File | null;
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });
  if (file.size > 500_000) return NextResponse.json({ error: 'Too large' }, { status: 413 });

  // Quick reject on client-supplied MIME before reading bytes.
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, or WebP images allowed' }, { status: 415 });
  }

  // Authoritative check: read magic bytes from the actual file content.
  const headerBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const detected    = detectImageType(headerBytes);
  if (!detected) {
    return NextResponse.json({ error: 'File is not a valid JPEG, PNG, or WebP' }, { status: 415 });
  }

  const ext = detected === 'image/jpeg' ? 'jpg' : detected === 'image/png' ? 'png' : 'webp';
  const blob = await put(`photos/${session.user.id}.${ext}`, file, {
    access:          'public',
    addRandomSuffix: false,
    contentType:     detected,
  });

  // Persist the blob URL directly into workoutData.settings so the photo is
  // immediately available via /api/user and /api/friends without waiting for
  // the client-side sync push to complete.
  const existing = await prisma.workoutData.findUnique({ where: { userId: session.user.id } });
  const merged   = { ...((existing?.settings ?? {}) as Record<string, unknown>), queProfilePhoto: blob.url };
  await prisma.workoutData.upsert({
    where:  { userId: session.user.id },
    create: { userId: session.user.id, localDB: {} as never, profile: {} as never, settings: merged as never },
    update: { settings: merged as never },
  });

  return NextResponse.json({ url: blob.url });
}

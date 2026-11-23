import { SUPABASE_AUDIO_BUCKET, supabase } from './supabase';

function safeStorageName(value: string) {
  return value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'track';
}

async function sourceToBlob(source: Blob | string) {
  if (source instanceof Blob) return source;
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Could not read audio for cloud backup: ${response.status}`);
  }
  return response.blob();
}

function objectPathFor(storagePath?: string) {
  if (!storagePath) return '';
  const prefix = `${SUPABASE_AUDIO_BUCKET}/`;
  return storagePath.startsWith(prefix)
    ? storagePath.slice(prefix.length)
    : storagePath;
}

export async function uploadTrackAudio(
  userId: string,
  trackId: string,
  source: Blob | string,
  onProgress?: (progress: number) => void,
  fileName = 'track.mp3',
  contentType?: string
) {
  if (!supabase) throw new Error('Supabase Storage is not configured.');

  const blob = await sourceToBlob(source);
  const safeTrackId = safeStorageName(trackId);
  const safeFileName = safeStorageName(fileName);
  const extension = safeFileName.includes('.')
    ? safeFileName.slice(safeFileName.lastIndexOf('.'))
    : '.mp3';
  const storagePath = `users/${userId}/music/${safeTrackId}-${Date.now()}${extension}`;

  onProgress?.(0.1);
  const { error } = await supabase.storage
    .from(SUPABASE_AUDIO_BUCKET)
    .upload(storagePath, blob, {
      contentType: contentType || blob.type || 'audio/mpeg',
      cacheControl: '3600',
      upsert: false,
    });
  if (error) throw error;
  onProgress?.(1);

  const { data } = supabase.storage
    .from(SUPABASE_AUDIO_BUCKET)
    .getPublicUrl(storagePath);

  return {
    downloadUrl: data.publicUrl,
    storagePath,
  };
}

export async function deleteTrackAudio(storagePath?: string) {
  if (!supabase) return;
  const objectPath = objectPathFor(storagePath);
  if (!objectPath) return;
  const { error } = await supabase.storage
    .from(SUPABASE_AUDIO_BUCKET)
    .remove([objectPath]);
  if (error) throw error;
}

import { deleteObject, ref } from 'firebase/storage';
import { storage } from './firebase';

export async function uploadTrackAudio(
  _userId: string,
  _trackId: string,
  sourceUrl: string,
  onProgress?: (progress: number) => void
) {
  onProgress?.(100);
  return {
    downloadUrl: sourceUrl,
    storagePath: '',
  };
}

export async function deleteTrackAudio(storagePath?: string) {
  if (!storagePath) return;
  await deleteObject(ref(storage, storagePath));
}

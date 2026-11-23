export interface AudioBlobResult {
  blob: Blob;
  contentType: string;
}

export async function fetchAudioBlob(
  url: string,
  onProgress?: (progress: number) => void
): Promise<AudioBlobResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Audio download failed with status ${response.status}`);
  }

  const contentType =
    response.headers.get('content-type')?.split(';')[0].trim() ||
    'application/octet-stream';

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(1);
    return { blob, contentType };
  }

  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(total > 0 ? Math.min(received / total, 0.99) : 0);
  }

  onProgress?.(1);
  return {
    blob: new Blob(chunks, { type: contentType }),
    contentType,
  };
}

export function sanitizeDownloadFilename(filename: string, fallbackTitle: string) {
  const cleaned = filename
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || `${fallbackTitle.replace(/[^\w\s-]/g, '').trim() || 'soniq-audio'}.mp3`;
}

export function downloadBlobToDevice(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = sanitizeDownloadFilename(filename, 'soniq-audio');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

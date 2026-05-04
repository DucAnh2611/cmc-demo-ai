import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { svcLog } from '@/lib/devLog';

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'uploads';

let _service: BlobServiceClient | null = null;
let _container: ContainerClient | null = null;
let _ensured = false;

export function isBlobConfigured(): boolean {
  return !!CONN;
}

export function getBlobService(): BlobServiceClient {
  if (_service) return _service;
  if (!CONN) throw new Error('AZURE_STORAGE_CONNECTION_STRING must be set');
  _service = BlobServiceClient.fromConnectionString(CONN);
  return _service;
}

export async function getUploadsContainer(): Promise<ContainerClient> {
  if (_container && _ensured) return _container;
  const svc = getBlobService();
  _container = svc.getContainerClient(CONTAINER_NAME);
  if (!_ensured) {
    // PrivateAccess — never expose blobs publicly. All reads go through
    // the /api/source/[id]/download endpoint which re-checks ACL via Search.
    await _container.createIfNotExists();
    _ensured = true;
  }
  return _container;
}

export interface BlobUploadInput {
  blobName: string;          // unique name (UUID + ext)
  buffer: Buffer;
  contentType: string;
  metadata: Record<string, string>; // becomes blob metadata; ASCII-only values
}

export async function uploadBlob(input: BlobUploadInput): Promise<string> {
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(input.blobName);
  const t0 = Date.now();
  await block.uploadData(input.buffer, {
    blobHTTPHeaders: { blobContentType: input.contentType },
    // Azure Blob metadata values must be ASCII; sanitise upstream.
    metadata: input.metadata
  });
  svcLog({
    service: 'blob',
    op: 'upload',
    details: `${input.blobName} · ${input.buffer.length}B`,
    ms: Date.now() - t0
  });
  return block.url; // private URL — anonymous access denied; auth via account key only
}

export async function downloadBlob(blobName: string): Promise<{
  buffer: Buffer;
  contentType: string;
  metadata: Record<string, string>;
} | null> {
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(blobName);
  const t0 = Date.now();
  if (!(await block.exists())) {
    svcLog({ service: 'blob', op: 'download', details: `${blobName} · NOT FOUND`, ms: Date.now() - t0 });
    return null;
  }
  const props = await block.getProperties();
  const dl = await block.downloadToBuffer();
  svcLog({
    service: 'blob',
    op: 'download',
    details: `${blobName} · ${dl.length}B`,
    ms: Date.now() - t0
  });
  return {
    buffer: dl,
    contentType: props.contentType || 'application/octet-stream',
    metadata: (props.metadata as Record<string, string>) || {}
  };
}

export async function deleteBlob(blobName: string): Promise<void> {
  const container = await getUploadsContainer();
  const block = container.getBlockBlobClient(blobName);
  await block.deleteIfExists();
}

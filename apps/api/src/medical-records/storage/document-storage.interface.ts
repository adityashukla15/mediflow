
export interface StoredDocument {
  storageKey: string;
  sizeBytes: number;
  checksum: string;
}

export interface DocumentStorage {
  put(
    storageKey: string,
    content: NodeJS.ReadableStream,
    options: {
      contentType: string;
      maxBytes: number;
    },
  ): Promise<StoredDocument>;

  get(storageKey: string): Promise<NodeJS.ReadableStream>;

  getPresignedDownloadUrl(
    storageKey: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  delete(storageKey: string): Promise<void>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

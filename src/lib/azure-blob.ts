import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from "@azure/storage-blob";

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function getConnStr(): string {
  const raw = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!raw) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
  const s = stripBom(raw);
  if (!s.includes("AccountKey=") && !s.includes("SharedAccessSignature=")) {
    throw new Error(`AZURE_STORAGE_CONNECTION_STRING malformed (len=${s.length})`);
  }
  return s;
}

function getClient() {
  return BlobServiceClient.fromConnectionString(getConnStr());
}

function containerName() {
  return process.env.AZURE_STORAGE_CONTAINER ?? "pm-agent-docs";
}

export async function uploadToBlob(
  orgId: string,
  projectId: string,
  docId: string,
  buffer: Buffer,
  filename: string
): Promise<string> {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName());
  await containerClient.createIfNotExists();

  const blobName = `${orgId}/${projectId}/${docId}-${filename}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: "application/octet-stream" },
  });
  return blockBlobClient.url;
}

export async function generateSasUrl(blobUrl: string, expiryMinutes = 60): Promise<string> {
  const connStr = getConnStr();
  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey = connStr.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) throw new Error("Cannot parse storage credentials");

  const url = new URL(blobUrl);
  const [, container, ...blobParts] = url.pathname.split("/");
  const blobName = blobParts.join("/");

  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    },
    sharedKeyCredential
  );

  return `${blobUrl}?${sas.toString()}`;
}

export async function deleteBlob(blobUrl: string): Promise<void> {
  const client = getClient();
  const url = new URL(blobUrl);
  const [, container, ...blobParts] = url.pathname.split("/");
  const blobName = blobParts.join("/");
  const containerClient = client.getContainerClient(container);
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.deleteIfExists();
}

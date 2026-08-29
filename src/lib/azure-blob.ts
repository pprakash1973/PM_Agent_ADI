import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from "@azure/storage-blob";

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "pm-agent-docs";

function getClient() {
  if (!CONNECTION_STRING) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
  return BlobServiceClient.fromConnectionString(CONNECTION_STRING);
}

export async function uploadToBlob(
  orgId: string,
  projectId: string,
  docId: string,
  buffer: Buffer,
  filename: string
): Promise<string> {
  const client = getClient();
  const containerClient = client.getContainerClient(CONTAINER);
  await containerClient.createIfNotExists();

  const blobName = `${orgId}/${projectId}/${docId}-${filename}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: "application/octet-stream" },
  });
  return blockBlobClient.url;
}

export async function generateSasUrl(blobUrl: string, expiryMinutes = 60): Promise<string> {
  const client = getClient();
  // Parse account name + key from connection string
  const accountName = CONNECTION_STRING.match(/AccountName=([^;]+)/)?.[1];
  const accountKey = CONNECTION_STRING.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) throw new Error("Cannot parse storage credentials");

  const url = new URL(blobUrl);
  const [, containerName, ...blobParts] = url.pathname.split("/");
  const blobName = blobParts.join("/");

  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
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
  const [, containerName, ...blobParts] = url.pathname.split("/");
  const blobName = blobParts.join("/");
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.deleteIfExists();
}

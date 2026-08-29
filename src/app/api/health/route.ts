import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getApiKey } from "@/lib/providers/get-api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await (prisma as any).$queryRaw`SELECT 1`;
    dbOk = true;
  } catch { /* ignore */ }

  const anthropicKey = await getApiKey("anthropic").catch(() => undefined);

  const azureDiEnabled = !!(
    process.env.AZURE_DI_KEY &&
    process.env.AZURE_DI_ENDPOINT &&
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );

  return NextResponse.json({
    status: "ok",
    db: dbOk ? "connected" : "unreachable",
    anthropicKeyResolved: !!anthropicKey,
    anthropicKeyLength: anthropicKey?.length ?? 0,
    azureDiEnabled,
    env: {
      ANTHROPIC_API_KEY: describe(process.env.ANTHROPIC_API_KEY),
      AZURE_DI_ENDPOINT: describe(process.env.AZURE_DI_ENDPOINT),
      AZURE_DI_KEY: describe(process.env.AZURE_DI_KEY),
      AZURE_STORAGE_CONNECTION_STRING: describeConn(process.env.AZURE_STORAGE_CONNECTION_STRING),
      AUTH_SECRET: describe(process.env.AUTH_SECRET),
      DATABASE_URL: describe(process.env.DATABASE_URL),
    },
  });
}

function describe(v: string | undefined) {
  if (!v) return "MISSING";
  const bom = v.charCodeAt(0) === 0xFEFF;
  return `set (${v.length} chars${bom ? ", BOM!" : ""})`;
}

function describeConn(v: string | undefined) {
  if (!v) return "MISSING";
  const bom = v.charCodeAt(0) === 0xFEFF;
  return `set (${v.length} chars${bom ? ", BOM!" : ""}, hasAccountKey=${v.includes("AccountKey=")}, hasAccountName=${v.includes("AccountName=")})`;
}

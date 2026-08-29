export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireProjectAccess } from "@/lib/project-access";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireProjectAccess(id);
  if (access.error) return access.error;

  const { searchParams } = new URL(req.url);
  const docId = searchParams.get("docId");
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });

  const doc = await prisma.requirementsDocument.findFirst({
    where: { id: docId, projectId: id, deletedAt: null },
    select: { id: true, ingestionState: true, chunkCount: true, fileName: true, ocrApplied: true },
  });

  if (!doc) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json(doc);
}

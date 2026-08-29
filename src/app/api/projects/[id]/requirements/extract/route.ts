export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { anthropic } from "@/lib/ai";
import { requireProjectAccess } from "@/lib/project-access";

interface ExtractedRequirement {
  requirementKey: string;
  statement: string;
  type: "functional" | "non-functional" | "constraint" | "assumption";
  category: string;
  confidence: number;
  sourceQuote: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireProjectAccess(id);
  if (access.error) return access.error;

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Optional: scope extraction to a specific document (used on upload auto-extract)
  let documentId: string | undefined;
  try { documentId = (await req.json())?.documentId ?? undefined; } catch { /* no body */ }

  // Pull chunks — if a specific doc is given, only from that doc;
  // otherwise from all non-deleted docs (prevents stale chunks from soft-deleted docs)
  const chunkWhere: any = documentId
    ? { projectId: id, documentId }
    : { projectId: id, document: { deletedAt: null } };

  const chunks = await prisma.documentChunk.findMany({
    where: chunkWhere,
    orderBy: [{ documentId: "asc" }, { chunkIndex: "asc" }],
    take: 150,
    select: { id: true, text: true, sectionTitle: true, pageNumber: true, documentId: true },
  });

  if (chunks.length === 0) {
    return NextResponse.json({ error: "No document chunks found. Upload source documents first." }, { status: 400 });
  }

  // Build corpus — cap at ~12 000 chars to stay inside context limits
  let corpus = "";
  for (const chunk of chunks) {
    const prefix = chunk.sectionTitle ? `[${chunk.sectionTitle}] ` : "";
    const candidate = `${prefix}${chunk.text}\n`;
    if (corpus.length + candidate.length > 12000) break;
    corpus += candidate;
  }

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    system: `You are a senior business analyst. Extract ALL discrete requirements from the source document corpus provided.
A "requirement" is any statement that specifies:
- A functional need (what the system/project must do)
- A non-functional need (performance, security, compliance)
- A constraint (budget ceiling, deadline, regulatory rule, technology restriction)
- An explicit assumption

Rules:
- Only extract statements clearly present in the text — never infer or fabricate
- Each requirement must have a verbatim sourceQuote (exact text from the document proving it)
- Assign confidence: 1.0 = verbatim, 0.8 = paraphrased but clear, 0.6 = implied
- Return JSON only

Return JSON: { "requirements": [ { "requirementKey": "REQ-001", "statement": "...", "type": "functional|non-functional|constraint|assumption", "category": "scope|budget|timeline|quality|security|compliance|technical|resource|other", "confidence": 0.0-1.0, "sourceQuote": "exact verbatim text from source" } ] }`,
    messages: [{
      role: "user",
      content: `Project: ${project.name}\n\nSource corpus:\n${corpus}\n\nExtract all requirements. Return JSON only.`,
    }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "{}";
  let extracted: ExtractedRequirement[] = [];
  try {
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
    const parsed = JSON.parse(fenced ? fenced[1] : text);
    extracted = parsed.requirements ?? [];
  } catch {
    return NextResponse.json({ error: "Extraction failed — AI did not return valid JSON" }, { status: 500 });
  }

  // Find chunk + document that best matches each sourceQuote
  const chunkTextMap = chunks.map(c => ({ id: c.id, documentId: c.documentId, text: c.text.toLowerCase() }));

  function findChunk(quote: string): { chunkId: string; documentId: string } | null {
    const q = quote.toLowerCase().slice(0, 80);
    for (const c of chunkTextMap) {
      if (c.text.includes(q)) return { chunkId: c.id, documentId: c.documentId };
    }
    return null;
  }

  // Derive the source doc when all chunks are from a single document (scoped extraction)
  const uniqueDocIds = [...new Set(chunks.map(c => c.documentId))];
  const scopedDocId = uniqueDocIds.length === 1 ? uniqueDocIds[0] : null;

  // Get highest existing REQ number to avoid collisions
  const existingReqs = await prisma.requirement.findMany({
    where: { projectId: id },
    select: { requirementKey: true },
  });
  const maxExisting = existingReqs.reduce((m, r) => {
    const n = parseInt(r.requirementKey.replace("REQ-", ""), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);

  // Upsert requirements
  let created = 0;
  for (let i = 0; i < extracted.length; i++) {
    const req = extracted[i];
    const key = `REQ-${String(maxExisting + i + 1).padStart(3, "0")}`;
    const matched = req.sourceQuote ? findChunk(req.sourceQuote) : null;
    const sourceChunkId = matched?.chunkId ?? null;
    const sourceDocId = matched?.documentId ?? scopedDocId ?? null;
    await prisma.requirement.upsert({
      where: { projectId_requirementKey: { projectId: id, requirementKey: key } },
      create: {
        id: `${id}-${key}`,
        projectId: id,
        requirementKey: key,
        statement: req.statement,
        type: req.type ?? "functional",
        category: req.category ?? "other",
        source: "extracted",
        status: "proposed",
        confidence: req.confidence ?? 0.8,
        sourceChunkId: sourceChunkId ?? undefined,
        sourceDocId: sourceDocId ?? undefined,
        sourceQuote: req.sourceQuote?.slice(0, 500),
      },
      update: {
        statement: req.statement,
        confidence: req.confidence ?? 0.8,
        sourceChunkId: sourceChunkId ?? undefined,
        sourceDocId: sourceDocId ?? undefined,
        sourceQuote: req.sourceQuote?.slice(0, 500),
      },
    });
    created++;
  }

  return NextResponse.json({ extracted: created, requirements: extracted });
}

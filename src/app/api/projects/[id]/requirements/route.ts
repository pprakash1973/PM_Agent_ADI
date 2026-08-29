export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { anthropic } from "@/lib/ai";
import { extractPdfText } from "@/lib/pdf";
import { requireProjectAccess } from "@/lib/project-access";
import { rateLimit } from "@/lib/rate-limit";
import { uploadToBlob, generateSasUrl } from "@/lib/azure-blob";
import { analyzeDocument, diResultToChunks } from "@/lib/azure-di";

// File types handled by Azure DI (richer extraction)
const DI_SUPPORTED = new Set(["pdf", "docx", "doc"]);
const AZURE_DI_ENABLED = !!(process.env.AZURE_DI_KEY && process.env.AZURE_DI_ENDPOINT && process.env.AZURE_STORAGE_CONNECTION_STRING);

// Azure DI handles large files; keep a generous limit for non-DI types.
// Vercel caps request bodies at 4.5 MB — DI-eligible files go via Blob so
// this limit only applies to XLSX/TXT/CSV which are processed inline.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Each upload runs a paid extraction call, so bill it to the user like the other
// LLM-backed routes rather than leaving it unmetered.
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;

// Doc class → points toward evidence readiness score
const DOC_CLASS_POINTS: Record<string, number> = {
  sow: 30, brd: 25, srs: 20, estimation: 15, proposal: 10, contract: 10, cr: 5, other: 5,
};

function evidenceBand(score: number): string {
  if (score >= 70) return "strong";
  if (score >= 40) return "adequate";
  if (score >= 20) return "marginal";
  return "insufficient";
}

async function computeAndSaveReadiness(projectId: string) {
  const docs = await prisma.requirementsDocument.findMany({
    where: { projectId, deletedAt: null, ingestionState: "ready" },
    select: { docClass: true },
  });
  // Each class counts once (uploading 3 SOWs doesn't triple-count)
  const seenClasses = new Set(docs.map((d: { docClass: string }) => d.docClass));
  let score = 0;
  for (const cls of seenClasses) score += DOC_CLASS_POINTS[cls as string] ?? 5;
  score = Math.min(score, 100);
  const band = evidenceBand(score);
  await prisma.project.update({
    where: { id: projectId },
    data: { evidenceReadinessScore: score, evidenceReadinessBand: band },
  });
  return { score, band };
}

// Chunk raw text into ~500-char segments with locator metadata
function chunkText(text: string): Array<{
  chunkIndex: number; pageNumber: number; charStart: number; charEnd: number;
  sectionTitle: string | null; text: string; tokenCount: number;
}> {
  const CHARS_PER_PAGE = 3000;
  const TARGET_CHUNK = 500;

  // Split on paragraph boundaries first
  const paragraphs = text.split(/\n{2,}/);
  const chunks: ReturnType<typeof chunkText> = [];
  let chunkIndex = 0;
  let globalChar = 0;
  let currentText = "";
  let currentStart = 0;
  let currentSection: string | null = null;

  function flush() {
    const t = currentText.trim();
    if (!t) return;
    const charStart = currentStart;
    const charEnd = charStart + t.length;
    chunks.push({
      chunkIndex: chunkIndex++,
      pageNumber: Math.floor(charStart / CHARS_PER_PAGE) + 1,
      charStart,
      charEnd,
      sectionTitle: currentSection,
      text: t,
      tokenCount: Math.ceil(t.length / 4), // rough token estimate
    });
    currentText = "";
  }

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) { globalChar += para.length + 2; continue; }

    // Detect section headings (all-caps lines or lines ending with : under 80 chars)
    if ((trimmed === trimmed.toUpperCase() && trimmed.length < 80 && /[A-Z]/.test(trimmed))
      || (trimmed.endsWith(":") && trimmed.length < 80)) {
      flush();
      currentSection = trimmed;
      globalChar += para.length + 2;
      continue;
    }

    if (currentText.length + trimmed.length > TARGET_CHUNK) flush();

    if (!currentText) currentStart = globalChar;
    currentText += (currentText ? " " : "") + trimmed;
    globalChar += para.length + 2;
  }
  flush();
  return chunks;
}

async function extractFileText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (ext === "pdf") {
    return await extractPdfText(buffer);
  }
  if (ext === "docx") {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch {
      throw new Error(
        "Could not read the DOCX file. Ensure it is a valid Word document (not a .doc renamed to .docx). Try re-saving it from Microsoft Word and uploading again."
      );
    }
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const lines: string[] = [];
    for (const sheetName of wb.SheetNames) {
      lines.push(`=== ${sheetName} ===`);
      lines.push(XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]));
    }
    return lines.join("\n");
  }
  if (ext === "txt" || ext === "csv") return buffer.toString("utf-8");
  if (ext === "doc") throw new Error("Old .doc format not supported. Re-save as .docx.");
  throw new Error(`Unsupported file type: .${ext}`);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireProjectAccess(id);
  if (access.error) return access.error;
  const user = access.user;

  const limited = rateLimit(`requirements-upload:${user.id}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many uploads. Please wait ${Math.ceil(limited.retryAfterSec / 60)} minute(s) and try again.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` },
      { status: 413 }
    );
  }

  const docClass = (formData.get("docClass") as string | null) ?? "other";
  const effectiveDateRaw = formData.get("effectiveDate") as string | null;
  const effectiveDate = effectiveDateRaw ? new Date(effectiveDateRaw) : null;
  const confidentialityTier = (formData.get("confidentialityTier") as string | null) ?? "standard";

  // Prevent duplicate uploads — reject if this filename is already stored for this project
  const existing = await prisma.requirementsDocument.findFirst({
    where: { projectId: id, fileName: file.name, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `"${file.name}" is already uploaded for this project. Delete the existing document first if you want to replace it.` },
      { status: 409 }
    );
  }

  const fileExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const useDI = AZURE_DI_ENABLED && DI_SUPPORTED.has(fileExt);

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // ── Azure DI path (PDF / DOCX) ────────────────────────────────────────────
  if (useDI) {
    // 1. Upload to Azure Blob
    let blobUrl: string;
    try {
      blobUrl = await uploadToBlob((project as any).orgId ?? id, id, `${Date.now()}`, buffer, file.name);
    } catch (err: any) {
      return NextResponse.json({ error: `Blob upload failed: ${err.message}` }, { status: 500 });
    }

    // 2. Save document record with ingestionState "processing"
    let doc: any;
    try {
      doc = await prisma.requirementsDocument.create({
        data: {
          projectId: id,
          fileName: file.name,
          fileFormat: fileExt,
          storageUri: blobUrl,
          extractedContent: {},
          extractionConfidence: null,
          ocrApplied: true,
          pmConfirmed: false,
          uploadedById: user.id,
          docClass,
          effectiveDate,
          confidentialityTier,
          ingestionState: "processing",
          chunkCount: 0,
        },
      });
    } catch (err: any) {
      console.error("[requirements upload] DB save failed:", err);
      return NextResponse.json({ error: "Failed to save document record." }, { status: 500 });
    }

    // 3. Run DI analysis + chunking synchronously (works on Azure App Service;
    //    on Vercel this may timeout for very large docs — frontend polls /status if needed)
    try {
      const sasUrl = await generateSasUrl(blobUrl, 10);
      const resultJson = await analyzeDocument(sasUrl);
      const chunks = diResultToChunks(resultJson);

      // Extract metadata from DI content for extractedContent field
      const diResult = JSON.parse(resultJson);
      const fullText = (diResult.content ?? "").slice(0, 15000);
      let extractedContent: Record<string, unknown> = {};
      try {
        const msg = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: `You are a PMO AI assistant. Extract structured project information from requirements documents.
Return ONLY valid JSON: { "projectName": string|null, "objectives": string[], "inScope": string[], "outOfScope": string[], "stakeholders": [{"name":string,"role":string}], "constraints": string[], "assumptions": string[], "acceptanceCriteria": string[], "keyRequirements": string[] }`,
          messages: [{ role: "user", content: `Project: ${project.name}\n\nDocument content:\n${fullText}` }],
        });
        const txt = msg.content[0].type === "text" ? msg.content[0].text : "{}";
        const fenced = txt.match(/```json\s*([\s\S]*?)\s*```/);
        extractedContent = JSON.parse(fenced ? fenced[1] : txt);
      } catch { /* non-fatal */ }

      await prisma.$transaction(async (tx: any) => {
        await tx.requirementsDocument.update({
          where: { id: doc.id },
          data: { ingestionState: "ready", chunkCount: chunks.length, extractedContent: extractedContent as object, extractionConfidence: 0.92 },
        });
        if (chunks.length > 0) {
          await tx.documentChunk.createMany({
            data: chunks.map((c: any) => ({ id: `${doc.id}-${c.chunkIndex}`, documentId: doc.id, projectId: id, ...c })),
          });
        }
      });

      doc = await prisma.requirementsDocument.findUnique({ where: { id: doc.id } });
      const readiness = await computeAndSaveReadiness(id).catch(() => ({ score: 0, band: "insufficient" }));
      return NextResponse.json({ doc, extractedContent, readiness, chunkCount: chunks.length, engine: "azure-di" }, { status: 201 });
    } catch (err: any) {
      // DI failed — mark as failed so frontend can show error
      await prisma.requirementsDocument.update({
        where: { id: doc.id },
        data: { ingestionState: "failed" },
      }).catch(() => {});
      console.error("[requirements upload] DI processing failed:", err);
      return NextResponse.json({ error: `Document analysis failed: ${err.message}` }, { status: 500 });
    }
  }

  // ── Text-based path (XLSX / TXT / CSV) ───────────────────────────────────
  let rawText: string;
  try {
    rawText = await extractFileText(file);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 });
  }

  let extractedContent: Record<string, unknown> = {};
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: `You are a PMO AI assistant. Extract structured project information from requirements documents.
Return ONLY valid JSON: { "projectName": string|null, "objectives": string[], "inScope": string[], "outOfScope": string[], "stakeholders": [{"name":string,"role":string}], "constraints": string[], "assumptions": string[], "acceptanceCriteria": string[], "keyRequirements": string[] }`,
      messages: [{ role: "user", content: `Project: ${project.name}\n\nDocument content:\n${rawText.slice(0, 15000)}` }],
    });
    const responseText = message.content[0].type === "text" ? message.content[0].text : "{}";
    const fenced = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    extractedContent = JSON.parse(fenced ? fenced[1] : responseText);
  } catch { /* non-fatal */ }

  const chunks = chunkText(rawText);

  let doc;
  try {
    doc = await prisma.$transaction(async (tx: any) => {
      const created = await tx.requirementsDocument.create({
        data: {
          projectId: id,
          fileName: file.name,
          fileFormat: fileExt,
          storageUri: `inline:${id}:${Date.now()}`,
          extractedContent: extractedContent as object,
          extractionConfidence: 0.85,
          pmConfirmed: false,
          uploadedById: user.id,
          docClass,
          effectiveDate,
          confidentialityTier,
          ingestionState: "ready",
          chunkCount: chunks.length,
        },
      });
      if (chunks.length > 0) {
        await tx.documentChunk.createMany({
          data: chunks.map(c => ({ id: `${created.id}-${c.chunkIndex}`, documentId: created.id, projectId: id, ...c })),
        });
      }
      return created;
    });
  } catch (err: any) {
    console.error("[requirements upload] DB transaction failed:", err);
    return NextResponse.json({ error: "Failed to save document. Please try again." }, { status: 500 });
  }

  const readiness = await computeAndSaveReadiness(id).catch(() => ({ score: 0, band: "insufficient" }));
  return NextResponse.json({ doc, extractedContent, readiness, chunkCount: chunks.length, engine: "text" }, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireProjectAccess(id);
  if (access.error) return access.error;

  const docs = await prisma.requirementsDocument.findMany({
    where: { projectId: id, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(docs);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireProjectAccess(id);
  if (access.error) return access.error;

  const { searchParams } = new URL(req.url);
  const docId = searchParams.get("docId");
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });

  // Deletion is blocked only if this doc's requirements are captured in the current baseline snapshot
  const latestBl = await (prisma as any).scopeBaseline.findFirst({
    where: { projectId: id },
    orderBy: { version: "desc" },
    select: { snapshot: true, label: true },
  }).catch(() => null);

  if (latestBl) {
    const docReqs = await prisma.requirement.findMany({
      where: { projectId: id, sourceDocId: docId },
      select: { requirementKey: true },
    });
    const docReqKeys = new Set(docReqs.map((r: any) => r.requirementKey));
    const snapshot: any[] = latestBl.snapshot ?? [];
    const inBaseline = snapshot.some((r: any) => docReqKeys.has(r.requirementKey));
    if (inBaseline) {
      return NextResponse.json(
        { error: `This document's requirements are locked in baseline "${latestBl.label}". Roll back that baseline before deleting.` },
        { status: 403 }
      );
    }
  }

  const doc = await prisma.requirementsDocument.findFirst({
    where: { id: docId, projectId: id, deletedAt: null },
    select: { id: true },
  });
  if (!doc) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Remove requirements that trace back to this document
  try {
    await prisma.requirement.deleteMany({ where: { projectId: id, sourceDocId: docId } });
  } catch {
    // sourceDocId column may not exist on older deployments — skip
  }

  // Hard-delete DocumentChunk records (soft-deleting the parent doesn't cascade)
  await prisma.documentChunk.deleteMany({ where: { documentId: docId } });

  // Soft-delete the document
  await prisma.requirementsDocument.update({
    where: { id: docId },
    data: { deletedAt: new Date() },
  });

  const readiness = await computeAndSaveReadiness(id).catch(() => ({ score: 0, band: "insufficient" }));
  return NextResponse.json({ ok: true, readiness });
}

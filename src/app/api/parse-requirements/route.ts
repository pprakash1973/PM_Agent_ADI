export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { extractRequirements, generateProjectFromNL } from "@/lib/ai";
import { extractPdfText } from "@/lib/pdf";

// ─── Text normalisation ───────────────────────────────────────────────────────

/**
 * Fix split requirement IDs and strip common PDF boilerplate.
 *
 * pdfjs sometimes renders the hyphen in "REQ-001" as a separate text item so
 * joining with spaces produces "REQ - 001" or "REQ -001". The normalisation
 * regex collapses these back to "REQ-001" before pattern matching.
 */
function normalizeText(text: string): string {
  return text
    // Fix split IDs: "REQ -001", "REQ – 001", "FR- 002" → canonical form
    .replace(/\b([A-Z]{2,5})\s*[–—\-]\s*(\d{3,})\b/g, "$1-$2")
    // Strip page numbers
    .replace(/\bPage\s+\d+\b[^\n]{0,50}/gi, "")
    // Strip copyright / confidentiality lines
    .replace(/©\s*\d{4}[^\n]{0,120}/g, "")
    .replace(/confidential\s+and\s+proprietary[^\n]{0,120}/gi, "")
    // Collapse whitespace
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Regex requirement extraction ─────────────────────────────────────────────

/**
 * Directly extract every explicitly numbered requirement from the normalised text.
 *
 * Works on documents of any size — no AI token budget consumed.
 * Deduplicates by ID so that later references (e.g. an RTM appendix) don't create
 * phantom duplicates of requirements already captured from the main body.
 *
 * Returns [] for unstructured documents (< 3 IDs found), triggering AI fallback.
 */
function extractNumberedRequirements(text: string): string[] {
  const lines = text.split("\n");
  const results: string[] = [];
  const seen = new Set<string>();
  // Pattern: 2-5 uppercase letters + hyphen + 3+ digits (REQ-001, FR-001, NFR-010 …)
  const idPattern = /\b([A-Z]{2,5}-\d{3,})\b/;

  for (const line of lines) {
    const match = line.match(idPattern);
    if (!match) continue;

    const reqId = match[1];
    // First occurrence is the canonical definition; later refs (RTM, cross-refs) are skipped
    if (seen.has(reqId)) continue;
    seen.add(reqId);

    // Everything after the ID on this line is the requirement content
    let content = line.slice(match.index! + match[0].length).trim();

    // Strip MoSCoW priority word that appears as the first token in BRD tables
    content = content.replace(
      /^(Must Have|Should Have|Could Have|Won't Have|Must|Should|Could|Won't)\s+/i,
      ""
    );

    // Strip table column-header noise that occasionally bleeds into the same row
    content = content.replace(
      /\b(Req(?:uirement)?\s+ID|Priority|Acceptance\s+Criteria|Requirement\s+Statement)\b/gi,
      " "
    );

    content = content.replace(/\s+/g, " ").trim();
    if (content.length > 500) content = content.slice(0, 500).trim();

    if (content.length > 0) {
      results.push(`${reqId}: ${content}`);
    }
  }

  return results;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json(
        { error: { code: "NO_FILE", message: "No file uploaded" } },
        { status: 400 }
      );

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "doc") {
      return NextResponse.json(
        {
          error: {
            code: "UNSUPPORTED_FORMAT",
            message:
              "Old .doc format is not supported. Please save your file as .docx (Word 2007 or later) and try again.",
          },
        },
        { status: 400 }
      );
    }

    const supported = ["pdf", "docx", "txt", "md"];
    if (!supported.includes(ext)) {
      return NextResponse.json(
        {
          error: {
            code: "UNSUPPORTED_FORMAT",
            message: `Unsupported file type .${ext}. Supported formats: PDF, DOCX, TXT.`,
          },
        },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let text = "";

    if (ext === "pdf") {
      text = await extractPdfText(buffer);
    } else if (ext === "docx") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      if (result.messages?.some((m: any) => m.type === "error")) {
        console.warn("mammoth warnings:", result.messages);
      }
      text = result.value;
    } else {
      text = buffer.toString("utf-8");
    }

    if (!text.trim()) {
      return NextResponse.json(
        {
          error: {
            code: "EMPTY_FILE",
            message:
              "Could not extract any text from the file. Make sure the document contains readable text (not just images or scans).",
          },
        },
        { status: 400 }
      );
    }

    // Normalise: fix split IDs and strip boilerplate
    const cleanedText = normalizeText(text);

    // ── Regex-first extraction ──────────────────────────────────────────────
    // For documents with explicit requirement IDs (BRD, SRS, SOW with numbered items):
    // extract every ID directly — no AI token budget consumed, works on any doc size.
    // Falls back to AI scopeItems for unstructured documents.
    const numberedReqs = extractNumberedRequirements(cleanedText);
    const hasNumberedReqs = numberedReqs.length >= 3;

    // AI handles metadata: goals, stakeholders, constraints, timeline, risks, etc.
    const truncated = cleanedText.slice(0, 100_000);

    const [aiExtracted, projectFields] = await Promise.all([
      extractRequirements(truncated),
      generateProjectFromNL(truncated),
    ]);

    // Regex requirements override AI scopeItems when found
    const requirements = hasNumberedReqs
      ? { ...aiExtracted, scopeItems: numberedReqs }
      : aiExtracted;

    return NextResponse.json({
      fileName: file.name,
      fileFormat: ext,
      extractedText: truncated,
      requirements,
      projectFields,
    });
  } catch (err: any) {
    console.error("parse-requirements error:", err);
    const msg = err?.message || "Failed to parse file";
    return NextResponse.json(
      { error: { code: "SERVER_ERROR", message: `Parse error: ${msg}` } },
      { status: 500 }
    );
  }
}

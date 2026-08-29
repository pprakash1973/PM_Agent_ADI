import { DocumentAnalysisClient, AzureKeyCredential, AnalyzeResult } from "@azure/ai-form-recognizer";

const ENDPOINT = process.env.AZURE_DI_ENDPOINT ?? "";
const KEY = process.env.AZURE_DI_KEY ?? "";

export interface DiChunk {
  chunkIndex: number;
  pageNumber: number;
  charStart: number;
  charEnd: number;
  sectionTitle: string | null;
  text: string;
  tokenCount: number;
}

function getClient() {
  if (!ENDPOINT || !KEY) throw new Error("Azure DI credentials not configured");
  return new DocumentAnalysisClient(ENDPOINT, new AzureKeyCredential(KEY));
}

export async function analyzeDocument(sasUrl: string): Promise<string> {
  const client = getClient();
  const poller = await client.beginAnalyzeDocumentFromUrl("prebuilt-layout", sasUrl);
  const result = await poller.pollUntilDone();
  return JSON.stringify(result);
}

// Roles to exclude from chunks (noise)
const EXCLUDED_ROLES = new Set(["pageHeader", "pageFooter", "pageNumber"]);

export function diResultToChunks(resultJson: string): DiChunk[] {
  const result: AnalyzeResult = JSON.parse(resultJson);
  const chunks: DiChunk[] = [];
  let chunkIndex = 0;
  let charCursor = 0;

  // Group paragraphs under section headings, flush at ~500 chars
  let currentSection: string | null = null;
  let currentText = "";
  let currentPage = 1;
  let currentStart = 0;

  function flush() {
    const t = currentText.trim();
    if (!t) return;
    const charStart = currentStart;
    const charEnd = charStart + t.length;
    chunks.push({
      chunkIndex: chunkIndex++,
      pageNumber: currentPage,
      charStart,
      charEnd,
      sectionTitle: currentSection,
      text: t,
      tokenCount: Math.ceil(t.length / 4),
    });
    currentText = "";
  }

  // Process paragraphs (structured, role-tagged)
  if (result.paragraphs && result.paragraphs.length > 0) {
    for (const para of result.paragraphs) {
      const role = (para as any).role as string | undefined;
      const content = para.content?.trim() ?? "";
      if (!content) continue;

      // Skip noise roles
      if (role && EXCLUDED_ROLES.has(role)) {
        charCursor += content.length + 1;
        continue;
      }

      // Section heading → flush current buffer, start new section
      if (role === "sectionHeading" || role === "title") {
        flush();
        currentSection = content;
        charCursor += content.length + 1;
        continue;
      }

      const pageNum = para.boundingRegions?.[0]?.pageNumber ?? currentPage;

      // Flush if adding this paragraph would exceed ~500 chars
      if (currentText.length + content.length > 500) flush();

      if (!currentText) {
        currentStart = charCursor;
        currentPage = pageNum;
      }
      currentText += (currentText ? " " : "") + content;
      charCursor += content.length + 1;
    }
    flush();
  }

  // Process tables — each table becomes its own chunk
  if (result.tables && result.tables.length > 0) {
    for (const table of result.tables) {
      const pageNum = table.boundingRegions?.[0]?.pageNumber ?? 1;

      // Build markdown table
      const rowCount = table.rowCount ?? 0;
      const colCount = table.columnCount ?? 0;
      const grid: string[][] = Array.from({ length: rowCount }, () => Array(colCount).fill(""));

      for (const cell of table.cells ?? []) {
        const text = cell.content?.trim() ?? "";
        if (cell.rowIndex < rowCount && cell.columnIndex < colCount) {
          grid[cell.rowIndex][cell.columnIndex] = text;
        }
      }

      const markdown = grid
        .map((row, i) => {
          const line = "| " + row.join(" | ") + " |";
          if (i === 0) return line + "\n|" + row.map(() => "---|").join("");
          return line;
        })
        .join("\n");

      if (markdown.trim()) {
        chunks.push({
          chunkIndex: chunkIndex++,
          pageNumber: pageNum,
          charStart: charCursor,
          charEnd: charCursor + markdown.length,
          sectionTitle: currentSection,
          text: markdown,
          tokenCount: Math.ceil(markdown.length / 4),
        });
        charCursor += markdown.length + 1;
      }
    }
  }

  return chunks;
}

/**
 * Shared artifact generation logic — called by both the artifacts API route
 * and the Copilot actions route (avoids internal unauthenticated HTTP calls).
 */
import { prisma } from "@/lib/db";
import { generateArtifact, type ArtifactTemplateOverride } from "@/lib/ai";
import { ARTIFACT_CATALOG } from "@/lib/utils";
import { runGuardrails, GuardrailError } from "@/lib/guardrails";
import { syncArtifactToTables } from "@/lib/artifact-sync";
import { hashArtifactContent } from "@/lib/artifact-hash";
import { extractAndStoreItems } from "@/lib/item-extractor";

// Cap large array fields in extractedContent so artifact prompts don't receive
// hundreds of scope items and produce output that overflows token budgets.
function capRequirementsContent(content: Record<string, unknown>): Record<string, unknown> {
  const cap = (arr: unknown, limit: number) =>
    Array.isArray(arr) ? arr.slice(0, limit) : arr;
  return {
    ...content,
    scopeItems:   cap(content.scopeItems,   60),
    goals:        cap(content.goals,        20),
    stakeholders: cap(content.stakeholders, 20),
    constraints:  cap(content.constraints,  20),
    assumptions:  cap(content.assumptions,  20),
    risks:        cap(content.risks,        20),
  };
}


async function resolveTemplate(orgId: string, accountId: string | null | undefined, artifactType: string): Promise<ArtifactTemplateOverride | undefined> {
  const db = prisma as any;

  // Preference order: account+type > account+"all" > global+type > global+"all"
  const candidates = await db.artifactTemplate.findMany({
    where: {
      orgId,
      isActive: true,
      OR: [
        // Account-specific matches (exact type or catch-all "all")
        ...(accountId ? [
          { scope: "account", accountId, artifactType },
          { scope: "account", accountId, artifactType: "all" },
        ] : []),
        // Global matches
        { scope: "global", accountId: null, artifactType },
        { scope: "global", accountId: null, artifactType: "all" },
      ],
    },
    orderBy: [{ scope: "desc" }, { artifactType: "desc" }], // account before global, exact before "all"
  });

  if (candidates.length === 0) return undefined;

  // Pick the highest-priority candidate
  const pick = candidates.find((t: any) => t.scope === "account" && t.artifactType === artifactType)
    ?? candidates.find((t: any) => t.scope === "account" && t.artifactType === "all")
    ?? candidates.find((t: any) => t.scope === "global" && t.artifactType === artifactType)
    ?? candidates[0];

  // A template with no addendum content has zero effect — treat as no template
  if (!pick.systemAddendum?.trim() && !pick.userAddendum?.trim()) return undefined;

  return {
    systemAddendum: pick.systemAddendum ?? undefined,
    userAddendum:   pick.userAddendum ?? undefined,
    templateId:     pick.id,
  };
}

export async function generateArtifactForProject(
  projectId: string,
  artifactType: string,
  userId: string
): Promise<{ artifact: any; noChange?: boolean; error?: never } | { artifact?: never; error: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      milestones: true,
      risks: true,
      requirementsDocs: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
      resources: true,
    },
  });

  if (!project) return { error: "Project not found" };

  const catalogEntry = ARTIFACT_CATALOG.find((a) => a.type === artifactType);
  if (!catalogEntry) return { error: `Unknown artifact type: ${artifactType}` };

  // Guardrails
  const [existingArtifacts, costEntryCount] = await Promise.all([
    prisma.artifact.findMany({ where: { projectId }, select: { artifactType: true } }),
    artifactType === "evm_analysis"
      ? prisma.costEntry.count({ where: { projectId } })
      : Promise.resolve(0),
  ]);

  try {
    runGuardrails(artifactType, {
      name: project.name,
      description: project.description,
      startDate: project.startDate,
      endDate: project.endDate,
      budget: project.budget,
      existingArtifactTypes: existingArtifacts.map((a) => a.artifactType),
      hasRequirementsDoc: project.requirementsDocs.length > 0,
      costEntryCount,
      milestoneCount: project.milestones.length,
      riskCount: project.risks.length,
    });
  } catch (err) {
    if (err instanceof GuardrailError) return { error: err.message };
    throw err;
  }

  // Extra context for specific types
  let scheduleTasks: { name: string; phase: string | null }[] = [];
  let wbsContent: unknown = null;
  if (artifactType === "traceability_matrix") {
    const [tasks, wbsArtifact] = await Promise.all([
      prisma.scheduleTask.findMany({ where: { projectId }, select: { name: true, phase: true }, take: 100 }),
      prisma.artifact.findFirst({ where: { projectId, artifactType: "wbs" }, select: { content: true } }),
    ]);
    scheduleTasks = tasks;
    wbsContent = wbsArtifact?.content ?? null;
  }

  let costEntries: { date: Date; amount: number; category: string }[] = [];
  if (artifactType === "evm_analysis") {
    costEntries = await prisma.costEntry.findMany({
      where: { projectId },
      select: { date: true, amount: true, category: true },
      orderBy: { date: "asc" },
    });
  }

  const projectContext = {
    name: project.name,
    code: project.code,
    customer: (project as any).customer,
    methodology: (project as any).methodology,
    engagementType: (project as any).engagementType,
    engagementMode: (project as any).engagementMode,
    budget: project.budget,
    currency: project.currency,
    startDate: project.startDate,
    endDate: project.endDate,
    teamSize: (project as any).teamSize,
    description: project.description,
    milestones: project.milestones,
    resources: ((project as any).resources ?? []).map((r: any) => ({
      name: r.name,
      role: r.role,
      allocation: r.allocation,
      skills: r.skills,
      email: r.email,
    })),
    ...(artifactType === "traceability_matrix" && { scheduleTasks, wbsStructure: wbsContent }),
    ...(artifactType === "evm_analysis" && {
      costEntries: costEntries.map((e) => ({
        date: e.date.toISOString().slice(0, 10),
        amount: e.amount,
        category: e.category,
      })),
    }),
  };

  // Large BRDs (200+ pages) produce extractedContent with 500+ scopeItems.
  // Sending all of them causes artifacts like WBS to enumerate every item as a
  // work package and overflow the output token budget.
  // Cap scopeItems to 60 (enough for WBS structure) and other arrays to 30;
  // keep all other fields intact so goals/stakeholders/constraints pass through.
  const rawExtracted = project.requirementsDocs[0]?.extractedContent;
  const requirements = rawExtracted
    ? JSON.stringify(capRequirementsContent(rawExtracted as Record<string, unknown>))
    : undefined;

  // Resolve active template for this project's account + artifact type
  const templateOverride = await resolveTemplate(
    (project as any).orgId,
    (project as any).accountId,
    artifactType
  );

  let content: any;
  try {
    content = await generateArtifact(artifactType, projectContext, requirements, undefined, templateOverride);
  } catch (err: any) {
    return { error: err.message ?? "AI generation failed" };
  }

  // Persist artifact + version (BL-5: suppress if content unchanged)
  const existing = await prisma.artifact.findFirst({
    where: { projectId, artifactType },
    include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
  });
  let artifact;
  const newHash = hashArtifactContent(content);

  if (existing) {
    const currentHash = (existing.versions[0] as any)?.contentHash ?? null;
    if (currentHash && currentHash === newHash) {
      return { artifact: existing, noChange: true };
    }
    const newVersion = existing.currentVersion + 1;
    const parentVersionId = existing.versions[0]?.id ?? null;
    artifact = await prisma.artifact.update({
      where: { id: existing.id },
      data: { content, currentVersion: newVersion, status: "draft" },
    });
    await (prisma.artifactVersion as any).create({
      data: {
        artifactId: existing.id,
        versionNumber: newVersion,
        content,
        contentHash: newHash,
        source: existing.currentVersion === 0 ? "ai_generated" : "ai_regenerated",
        approvalStatus: "unreviewed",
        parentVersionId,
        editedById: userId,
        appliedTemplateId: templateOverride?.templateId ?? null,
      },
    });
  } else {
    artifact = await prisma.artifact.create({
      data: { projectId, artifactType, phase: catalogEntry.phase, content, currentVersion: 1, status: "draft" },
    });
    await (prisma.artifactVersion as any).create({
      data: {
        artifactId: artifact.id,
        versionNumber: 1,
        content,
        contentHash: newHash,
        source: "ai_generated",
        approvalStatus: "unreviewed",
        parentVersionId: null,
        editedById: userId,
        appliedTemplateId: templateOverride?.templateId ?? null,
      },
    });
  }

  await prisma.artifactSelection.upsert({
    where: { projectId_artifactType: { projectId, artifactType } },
    create: { projectId, artifactType, selectionStatus: "active", selectedById: userId, selectedAt: new Date() },
    update: { selectionStatus: "active", selectedById: userId, selectedAt: new Date() },
  });

  syncArtifactToTables(projectId, artifactType, content).catch((err) => {
    console.error(`[artifact-sync] copilot sync failed for ${artifactType}:`, err);
  });

  // BL-P2: extract canonical items async (non-blocking)
  const latestVersion = await (prisma.artifactVersion as any).findFirst({
    where: { artifactId: artifact.id },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
  });
  if (latestVersion) {
    extractAndStoreItems(latestVersion.id, artifactType, content).catch((err) => {
      console.error("[item-extractor] async extraction failed:", err);
    });
  }

  return { artifact };
}

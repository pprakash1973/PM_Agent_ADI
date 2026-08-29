import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { GUARDRAIL_SYSTEM_ADDENDUM } from "@/lib/guardrails";
import { resolveModel } from "@/lib/model-router";
import { callLLM, streamLLM } from "@/lib/providers";
import { formatEvidenceForPrompt, type EvidenceContext } from "@/lib/evidence-assembler";
import { StatusSummarySchema } from "@/lib/schemas/status-summary.schema";
import { StatusQuestionsSchema } from "@/lib/schemas/status-questions.schema";
import { ScheduleRecoverySchema } from "@/lib/schemas/schedule-recovery.schema";
import { NlProjectSchema } from "@/lib/schemas/nl-project.schema";
import { extractJson } from "@/lib/extract-json";

// Lazy-initialised Anthropic client — avoids eager module-load so the key is
// never present in startup error traces or process dumps when it's misconfigured.
let _anthropic: Anthropic | null = null;
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    const raw = process.env.ANTHROPIC_API_KEY;
    if (!raw) throw new Error("ANTHROPIC_API_KEY is not configured");
    _anthropic = new Anthropic({ apiKey: stripBom(raw) });
  }
  return _anthropic;
}
export const anthropic = new Proxy({} as Anthropic, {
  get(_, prop) { return (getAnthropicClient() as any)[prop]; },
});

// Guards every JSON-producing AI call against silent truncation and schema violations (AC-7.2).
function parseAIJson(text: string, stopReason: string, label: string): Record<string, unknown>;
function parseAIJson<T>(text: string, stopReason: string, label: string, schema: z.ZodType<T>): T;
function parseAIJson<T>(
  text: string,
  stopReason: string,
  label: string,
  schema?: z.ZodType<T>
): T | Record<string, unknown> {
  if (stopReason === "max_tokens") {
    throw new Error(`AI response for "${label}" was truncated (hit token limit). Try a smaller input.`);
  }
  const raw = extractJson(text);
  if (!schema) return raw;
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = String((result as { success: false; error: unknown }).error);
    throw new Error(
      `AI response for "${label}" failed schema validation: ${issues}\nRaw (first 400 chars): ${JSON.stringify(raw).slice(0, 400)}`
    );
  }
  return (result as { success: true; data: T }).data;
}

const PMI_SYSTEM_PROMPT = `You are a senior PMO AI assistant with deep expertise in:
- EVM (Earned Value Management): PV, EV, AC, CPI, SPI, EAC, VAC, TCPI
- Risk management: cause→event→effect statements, P×I matrix, RBS categories, threat/opportunity strategies
- Scope management: WBS 100% rule, deliverable-oriented decomposition, scope baseline
- Stakeholder management: power/interest grid, engagement levels (Unaware→Resistant→Neutral→Supportive→Leading)
- RACI accountability: exactly one Accountable per activity, clear R/A/C/I distinctions
- Change control: integrated change control, CCB governance, baseline protection
- Benefits realization and project closure

Generate concise, professional project management artifacts.
Return ONLY valid JSON — no prose, no markdown outside the JSON block.
Arrays should have 3–8 items unless the schema requires more.
Base all figures and content strictly on the provided project context — do not fabricate numbers.
${GUARDRAIL_SYSTEM_ADDENDUM}`;

/**
 * Canonical top-level JSON keys for each artifact type.
 * Used by the upload route to tell the AI what structure to produce
 * when there is no existing artifact to infer the schema from.
 */
export const ARTIFACT_SCHEMA_HINTS: Record<string, string> = {
  project_charter:       "projectTitle, projectCode, version, projectDescription, businessCase, objectives, successCriteria, scope {inScope, outOfScope}, deliverables, milestones, budget, stakeholders, risks, assumptions, constraints, approvalSignatures",
  business_case:         "title, executiveSummary, problemStatement, proposedSolution, objectives, benefits, costs, risks, alternatives, recommendation, roi",
  stakeholder_register:  "stakeholders (array of {id, name, role, organization, email, power, interest, currentEngagement, desiredEngagement, communicationNeeds, notes})",
  assumption_log:        "assumptions (array of {id, description, category, impact, owner, dateLogged, status})",
  benefits_register:     "benefits (array of {id, description, type, owner, targetDate, measure, baselineValue, targetValue, status, notes})",
  scope_statement:       "projectScope, inScope (array), outOfScope (array), deliverables (array), acceptanceCriteria (array), constraints (array), assumptions (array)",
  wbs:                   "projectName, wbsCode, structuringApproach, phases (array of {id, name, componentType (Discrete|LoE), 100percentCheck, deliverables (array of {id, name, componentType, 100percentCheck, owner, workPackages (array of {id, name, componentType: 'Discrete', isWorkPackage: true, description, estimatedDays, owner, acceptanceCriteria, outOfScope, dependencies})})}), scopeBaselineSummary {totalComponents, totalWorkPackages, totalEstimatedDays, maxDepth, controlAccounts, structuringApproach}, qualityAudit (array of {check, description, result, evidence})",
  milestone_plan:        "milestones (array of {id, name, plannedDate, forecastDate, status, owner, deliverables, description})",
  resource_plan:         "teamDirectory (array of {id, name, role, department, skills, allocationPercent, startDate, endDate, dailyRate, currency, notes}), resourceCalendar, skillsMatrix, resourceConstraints, trainingNeeds",
  cost_plan:             "currency, estimatingMethod, laborEstimates (array of {role, resource, phase, estimatedDays, dailyRate, totalCost}), nonLaborCosts, totalBudget, contingencyReserve, managementReserve, bac, fundingRequirements",
  raid_register:         "risks (array of {id, description, probability, impact, status, owner, mitigation, requirementRef}), assumptions (array), issues (array of {id, description, severity, status, owner, resolution, dueDate}), dependencies (array)",
  risk_register:         "risks (array of {id, statement, category, probability, impact, riskScore, owner, responseActions, status, requirementRef})",
  communication_plan:    "stakeholderComms (array of {stakeholder, information, format, frequency, owner, channel})",
  raci_matrix:           "activities (array of {id, activity, phase, assignments (object keyed by role: R|A|C|I)}), roles (array of strings)",
  quality_plan:          "qualityObjectives, qualityStandards (array), qualityActivities (array of {activity, phase, owner, tool, acceptance}), metrics (array)",
  project_mgmt_plan:     "projectOverview {name, code, sponsor, pm, startDate, endDate, budget, objectives, successCriteria}, scopeManagement {scopeStatement, inScope, outOfScope, wbsApproach}, changeManagement {process, authority, impactThresholds}, riskManagement {approach, riskCategories, reviewCadence, topRisks}, costManagement {estimatingMethod, controlMethod, varianceThreshold, contingencyReserve, earnedValueApproach}, qualityManagement {qualityPolicy, standards, qaApproach}, scheduleManagement {methodology, tooling, keyMilestones}, resourceManagement {teamStructure, keyRoles}, communicationsManagement {approach, communicationItems, escalationPath}, stakeholderManagement {engagementStrategy, keyStakeholders}, keyAssumptions (array), keyDependencies (array), keyConstraints (array), approvalSignatures (array of {role, name, date})",
  action_log:            "actions (array of {id, description, owner, dueDate, priority, status, notes})",
  issue_register:        "issues (array of {id, description, severity, status, owner, resolutionPlan, dateRaised, dueDate})",
  decision_log:          "decisions (array of {id, description, decisionMade, rationale, owner, date, impact, alternatives})",
  weekly_status:         "reportDate, reportingPeriod, overallStatus, scheduleStatus, costStatus, scopeStatus, qualityStatus, accomplishments, plannedNextPeriod, risks, issues, decisions, metrics",
  monthly_status:        "reportDate, reportingPeriod, overallStatus, executiveSummary, milestoneStatus (array), budgetSummary, schedulePerformance, keyRisks, keyIssues, decisionsRequired",
  change_log:            "changes (array of {id, title, description, requestedBy, dateSubmitted, impact, status, approvedBy, implementationDate})",
  lessons_learned:       "lessons (array of {id, phase, category, description, impact, recommendation, owner, status})",
  closure_report:        "projectName, closureDate, sponsor, pm, objectivesAchievement (array), deliverablesStatus (array), budgetSummary, scheduleSummary, lessonsLearned (array), openItems (array), approvalSignatures (array)",
  traceability_matrix:       "requirements (array of {id, description, source, wbsRef, milestone, deliverable, acceptanceCriteria, validationMethod, owner, status})",
  dependencies_register:     "dependencies (array of {id, description, type (internal|external|technical|commercial), dependentOn, owner, expectedDate, status (open|resolved|at-risk), impact, mitigationAction})",
  quarterly_business_review: "quarter, projectName, executiveSummary, ragStatus, milestoneReview (array of {milestone, planned, forecast, status}), budgetSummary {budget, actualToDate, forecastAtCompletion, variance}, schedulePerformance {spi, spiTrend}, costPerformance {cpi, cpiTrend}, keyRisks (array), keyIssues (array), decisions (array), nextQuarterPlan (array), clientActions (array)",
};

// Per-type token budgets. WBS stays at 32k to handle 100-page BRDs/SOWs.
// Traceability matrix needs headroom for large requirement sets.
// Everything else is capped tightly to cut generation time proportionally.
const ARTIFACT_TOKEN_BUDGET: Record<string, number> = {
  wbs:                       16000,  // description+acceptanceCriteria removed; output is now ~50% smaller
  traceability_matrix:       16000,  // can have 50+ requirements
  project_charter:           12000,  // many nested arrays (milestones, stakeholders, risks, signatures)
  initiation_deck:           12000,  // RACI + team intro + escalation channels make this large
  evm_analysis:              10000,  // per-period data table + forecasts
  raid_register:              5000,  // 4 arrays; capped to keep generation under 60s
  risk_register:              4000,  // detailed risk entries; capped to keep generation under 60s
  raci_matrix:                8000,  // activities × roles matrix
  resource_plan:              8000,  // team directory + skills matrix
  cost_plan:                  8000,  // labor estimates + phase breakdown
  lessons_learned:            8000,  // detailed lesson entries
  closure_report:             8000,  // objectives scorecard + deliverables + benefits
  quarterly_business_review:  6000,
  project_mgmt_plan:          5000,  // master plan summary; concise sub-plan entries
  scope_statement:            5000,
  stakeholder_register:       5000,
  communication_plan:         5000,
  quality_plan:               5000,
  milestone_plan:             5000,
  business_case:              5000,
  change_log:                 5000,
  monthly_status:             5000,
  assumption_log:             4000,
  benefits_register:          4000,
  dependencies_register:      4000,
  weekly_status:              3000,
  action_log:                 3000,
  issue_register:             3000,
  decision_log:               3000,
};

export interface ArtifactTemplateOverride {
  systemAddendum?: string | null;
  userAddendum?: string | null;
  templateId?: string | null;
}

export async function generateArtifact(
  artifactType: string,
  projectContext: Record<string, unknown>,
  requirements?: string,
  evidenceContext?: EvidenceContext,
  templateOverride?: ArtifactTemplateOverride,
  onToken?: (text: string) => void,
  maxTokensOverride?: number
): Promise<Record<string, unknown>> {
  const content = buildArtifactContent(artifactType, projectContext, requirements, evidenceContext, templateOverride);
  const config = await resolveModel("artifact");

  const systemText = templateOverride?.systemAddendum
    ? `${PMI_SYSTEM_PROMPT}\n\nMANDATORY CLIENT-SPECIFIC INSTRUCTIONS — these override your defaults:\n${templateOverride.systemAddendum}`
    : PMI_SYSTEM_PROMPT;

  const userContent = content.map((b) => b.text).join("\n\n");
  const evidenceText = evidenceContext?.hasEvidence ? formatEvidenceForPrompt(evidenceContext) : undefined;
  const maxTokens = maxTokensOverride ?? ARTIFACT_TOKEN_BUDGET[artifactType] ?? 6000;

  const response = await streamLLM(
    {
      model:            config.model,
      maxTokens,
      system:           systemText,
      messages:         [{ role: "user", content: userContent }],
      temperature:      0,
      agent:            "artifact",
      retrievedContext: evidenceText,
      onToken,
    },
    config
  );

  return parseAIJson(response.text, response.stopReason, `artifact:${artifactType}`);
}

export async function generateProjectFromNL(description: string): Promise<Record<string, unknown>> {
  const config = await resolveModel("nl_project");
  const system = `You are a senior PMO AI. Extract structured project fields from a natural language description or requirements document.
Return JSON with these fields (infer from context; leave null if not found):
- name (string): project name
- customer (string): client or customer organization
- projectType (string): e.g. "Implementation", "Migration", "Transformation", "Development", "Consulting"
- methodology (string): waterfall | agile | kanban | safe | hybrid
- industry (string): e.g. "Financial Services", "Healthcare", "Retail", "Technology"
- projectSize (string): small | medium | large | enterprise
- budget (number): numeric budget value
- currency (string): USD | GBP | EUR etc.
- deliveryModel (string): fixed_price | time_and_material | managed_services | staff_aug
- teamSize (number): estimated team headcount
- startDate (string): ISO date
- endDate (string): ISO date
- description (string): concise project description
- objectives (array of strings): 3–5 SMART objectives
- scopeIncludes (array of strings): key in-scope deliverables
- scopeExcludes (array of strings): explicit exclusions
- constraints (array of strings): budget/schedule/regulatory constraints
- assumptions (array of strings): key assumptions
- conflicts (array of strings): REQUIRED — any conflicting requirements or contradictory statements found; empty array if none
- sponsor (string): executive sponsor name/role if mentioned
- clarifyingQuestions (array of strings): questions if critical info is missing`;

  const response = await callLLM(
    {
      model:       config.model,
      maxTokens:   config.maxTokens,
      system,
      messages:    [{ role: "user", content: `Extract project fields from this description:\n\n${description}\n\nReturn JSON only.` }],
      temperature: 0,
      agent:       "nl_project",
    },
    config
  );

  return parseAIJson(response.text, response.stopReason, "project-from-document", NlProjectSchema);
}

export interface StatusQuestion {
  id: number;
  category: string;
  question: string;
  type: "chips" | "multi-chips" | "number" | "select";
  suggestedAnswers: string[];
  allowCustom: boolean;
  required: boolean;
  placeholder?: string;
  unit?: string;
}

export async function generateStatusQuestions(
  projectContext: Record<string, unknown>
): Promise<StatusQuestion[]> {
  const config = await resolveModel("status_questions");
  const isAgile = projectContext.methodology === "agile_scrum" || projectContext.deliveryMethod === "agile_scrum";

  const system = isAgile
    ? `You are a senior PMO AI conducting a weekly sprint health check for a Scrum Product Owner / PM.
Generate exactly 10 targeted questions for an AGILE/SCRUM project based on its current context.

Rules:
- Use agile/scrum terminology — DO NOT use EVM terms like SPI, CPI, Earned Value, Planned Value.
- Categories to cover: Sprint Goal, Sprint Velocity, Backlog Health, Impediments, Budget Burn, Stakeholder Sentiment, Team Performance, Quality/DoD, Accomplishments, Next Sprint Plan
- Make questions SPECIFIC to the project's context (industry, phase, open risks, sprint state)
- Always include one Accomplishments question and one Next Sprint Plan question
- For EVERY question generate 4–6 suggested answers specific and realistic for this project
- Types:
  - "chips": PM picks ONE (single-select). Use for sprint goal status, velocity assessment, budget burn status.
  - "multi-chips": PM picks ONE OR MORE. Use for accomplishments, impediments, backlog changes, plans.
  - "select": dropdown for simple categorical choices (RAG, yes/no)
  - "number": numeric input for velocity points, impediment count, stories completed
- Set allowCustom: true when narrative answers are expected
- Return JSON: { "questions": [ { "id": 1, "category": "...", "question": "...", "type": "chips|multi-chips|select|number", "suggestedAnswers": ["...", "..."], "allowCustom": true|false, "required": true, "placeholder": "..." } ] }`
    : `You are a senior PMO AI conducting a weekly project health check for a Project Manager.
Generate exactly 10 targeted questions based on the project's current context.

Rules:
- Cover the most relevant categories from: Schedule, Budget, Scope, Quality, Risks, Issues, Team/Resources, Stakeholder Sentiment, Accomplishments, Next Week Plan, Change Requests
- Make questions SPECIFIC to the project data — if SPI < 1, probe the delay; if risks are open, ask about mitigation; if near deadline, ask about closure readiness
- Always include one Accomplishments question and one Next Week Plan question
- For EVERY question, generate 4–6 suggested answers that are SPECIFIC to this project's context, phase, industry, and current health. These should be realistic options a PM for this project would actually choose.
- Types:
  - "chips": PM picks ONE of the suggested answers (single-select chips). Use for status/assessment questions.
  - "multi-chips": PM picks ONE OR MORE suggested answers. Use for accomplishments, risks, plans, issues.
  - "select": dropdown for simple categorical choices (RAG, yes/no, methodology-specific)
  - "number": numeric input for percentages, counts, days
- Set allowCustom: true when the PM might have an answer not in the list (narrative, unique situations)
- Return JSON: { "questions": [ { "id": 1, "category": "...", "question": "...", "type": "chips|multi-chips|select|number", "suggestedAnswers": ["...", "..."], "allowCustom": true|false, "required": true, "placeholder": "..." } ] }`;

  const response = await callLLM(
    {
      model:       config.model,
      maxTokens:   config.maxTokens,
      system,
      messages:    [{ role: "user", content: `Generate 10 weekly status questions for this project:\n\n${JSON.stringify(projectContext, null, 2)}\n\nReturn JSON only.` }],
      temperature: 0,
      agent:       "status_questions",
    },
    config
  );

  const result = parseAIJson(response.text, response.stopReason, "status-questions", StatusQuestionsSchema);
  return result.questions;
}

export async function generateStatusSummary(
  rawInput: Record<string, unknown>,
  projectContext: Record<string, unknown>,
  liveEVM?: { pv: number; ev: number; sv: number; spi: number | null; overdueTasks: number; ac?: number; cpi?: number | null }
): Promise<{ summary: string; ragStatus: string; recommendations: string[]; accomplishments: string[]; nextWeekPlan: string[]; metricsNarrative: string; assumptions: string[]; conflicts: string[] }> {
  const evmSection = liveEVM
    ? `\n\nLIVE EVM DATA (computed from actual progress and cost entries — use these numbers directly in your report, do not invent alternatives):
- Planned Value (PV): ${liveEVM.pv.toFixed(1)} task-days
- Earned Value (EV): ${liveEVM.ev.toFixed(1)} task-days
- Schedule Variance (SV): ${liveEVM.sv > 0 ? "+" : ""}${liveEVM.sv.toFixed(1)} task-days
- Schedule Performance Index (SPI): ${liveEVM.spi != null ? liveEVM.spi.toFixed(2) : "N/A"}${liveEVM.spi != null ? (liveEVM.spi >= 1 ? " (on/ahead of schedule)" : liveEVM.spi >= 0.85 ? " (slight delay)" : " (significantly behind schedule)") : ""}
- Actual Cost (AC): ${liveEVM.ac != null && liveEVM.ac > 0 ? liveEVM.ac.toFixed(2) : "N/A — no cost entries recorded"}
- Cost Performance Index (CPI): ${liveEVM.cpi != null ? liveEVM.cpi.toFixed(3) : "N/A — no cost entries recorded"}${liveEVM.cpi != null ? (liveEVM.cpi >= 1 ? " (under/on budget)" : liveEVM.cpi >= 0.9 ? " (slight cost overrun)" : " (significant cost overrun)") : ""}
- Overdue tasks: ${liveEVM.overdueTasks}`
    : "";

  const config = await resolveModel("status_summary");
  const system = `You are a PMO AI. Generate a structured Weekly Status Report from the PM's Q&A responses.
Apply project monitoring and controlling principles. Do not introduce figures not in the inputs.
When live EVM data is provided, use those exact numbers in metricsNarrative — do not override them.

Return JSON with:
- summary (string): 2–3 sentence executive summary, stakeholder-ready
- ragStatus (string): "green" | "amber" | "red" with clear rationale from the answers
- recommendations (array of strings): 2–4 specific, actionable recommendations for the PM
- accomplishments (array of strings): bulleted accomplishments extracted from answers
- nextWeekPlan (array of strings): bulleted plan for next week extracted from answers
- metricsNarrative (string): 1–2 sentences describing schedule, budget, and quality status; include SPI, CPI, and SV if EVM data is provided
- assumptions (array of strings): REQUIRED — list any [ASSUMPTION] items or unstated assumptions identified in the PM answers; empty array if none
- conflicts (array of strings): REQUIRED — list any conflicting inputs or inconsistencies in the PM answers; empty array if none`;

  const response = await callLLM(
    {
      model:       config.model,
      maxTokens:   config.maxTokens,
      system,
      messages:    [{ role: "user", content: `Project context:\n${JSON.stringify(projectContext, null, 2)}${evmSection}\n\nPM Q&A responses:\n${JSON.stringify(rawInput, null, 2)}\n\nGenerate the Weekly Status Report. Return JSON only.` }],
      temperature: 0,
      agent:       "status_summary",
    },
    config
  );

  return parseAIJson(response.text, response.stopReason, "status-summary", StatusSummarySchema);
}

export async function generateScheduleRecovery(
  projectContext: Record<string, unknown>,
  evm: { pv: number; ev: number; sv: number; spi: number; overdueTasks: number; overdueTaskNames: string[] },
  tasks: { name: string; phase: string; percentComplete: number; baselineDays: number; status: string }[]
): Promise<{ headline: string; steps: { title: string; action: string; effort: string; impact: string }[]; estimatedRecovery: string; assumptions: string[]; conflicts: string[] }> {
  const config = await resolveModel("schedule_recovery");
  const system = `You are a PMO recovery specialist. A project is behind schedule (SPI < 0.8) and the PM needs a concrete recovery plan.
Apply schedule compression techniques: fast-tracking, crashing, scope reduction, resource reallocation.
Return JSON with:
- headline (string): 1-sentence diagnosis of the delay root cause based on the data
- steps (array of 4–6 objects): each has title (short action name), action (specific what-to-do in 2 sentences), effort ("Low"|"Medium"|"High"), impact ("Low"|"Medium"|"High")
- estimatedRecovery (string): realistic estimate of how many days/weeks recovery will take if steps are followed; label this as INDICATIVE since it is based on narrative analysis
- assumptions (array of strings): REQUIRED — assumptions made in this recovery plan; empty array if none
- conflicts (array of strings): REQUIRED — any conflicting constraints identified in the data; empty array if none`;

  const taskCap = 10;
  const response = await callLLM(
    {
      model:       config.model,
      maxTokens:   config.maxTokens,
      system,
      messages:    [{ role: "user", content: `Project: ${JSON.stringify(projectContext)}\n\nEVM metrics: SPI=${evm.spi}, SV=${evm.sv} task-days, PV=${evm.pv}, EV=${evm.ev}, Overdue tasks: ${evm.overdueTasks} (${evm.overdueTaskNames.join(", ")})\n\nTask breakdown (top ${taskCap} of ${tasks.length} total tasks shown — full list truncated for context limit): ${JSON.stringify(tasks.slice(0, taskCap))}\n\nGenerate recovery plan JSON only.` }],
      temperature: 0,
      agent:       "schedule_recovery",
    },
    config
  );

  return parseAIJson(response.text, response.stopReason, "schedule-recovery", ScheduleRecoverySchema);
}

// Max chars processed in a single requirements extraction call (~75k tokens; AC-3.1/AC-3.3)
const REQUIREMENTS_MAX_CHARS = 100_000;

export async function extractRequirements(text: string): Promise<Record<string, unknown>> {
  const config = await resolveModel("requirements");
  const totalChars    = text.length;
  const processedText = text.slice(0, REQUIREMENTS_MAX_CHARS);
  const processedChars = processedText.length;

  const system = `You are a PMO AI. Extract structured project requirements from documents.
Return JSON with:
- goals (array of strings): business/project goals
- scopeItems (array of strings): IMPORTANT — if the document contains explicitly numbered or labelled requirements (patterns like REQ-001, FR-001, BR-001, UC-001, NFR-001, or any "Req ID" column in a table), extract EVERY individual requirement as its own separate entry, verbatim or closely paraphrased — do NOT group or summarise them. If the document has no explicit numbering, extract high-level in-scope deliverables instead.
- outOfScope (array of strings): explicit exclusions if mentioned
- stakeholders (array of {name, role, interest}): key stakeholders
- constraints (array of strings): budget, schedule, regulatory, technical constraints
- assumptions (array of strings): REQUIRED — stated or implied assumptions about resources, environment, or conditions; empty array if none
- dependencies (array of {description: string, type: "internal"|"external"|"client", owner?: string}): REQUIRED — project dependencies on other work, systems, or decisions; empty array if none
- conflicts (array of strings): REQUIRED — any conflicting requirements or contradictory statements; empty array if none
- timeline (string): timeline description
- budgetSignals (string): any budget figures or signals
- methodology (string): delivery approach if mentioned
- risks (array of strings): any risks or concerns mentioned`;

  const response = await callLLM(
    {
      model:       config.model,
      maxTokens:   config.maxTokens,
      system,
      messages:    [{ role: "user", content: `Extract requirements from this document:\n\n${processedText}\n\nReturn JSON only.` }],
      temperature: 0,
      agent:       "requirements",
    },
    config
  );

  const result = parseAIJson(response.text, response.stopReason, "requirements-extraction");
  // Always include source char counts so callers can surface a warning when truncated (AC-3.4)
  return { ...result, sourceCharsProcessed: processedChars, sourceCharsTotal: totalChars };
}

export async function chatCommand(
  command: string,
  context: Record<string, unknown>
): Promise<string> {
  const config = await resolveModel("chat");
  const system = `You are a senior PMO AI copilot embedded inside PM Agent — an AI-powered project management platform.
Help the user with project management tasks, artifact generation, and project management best practices.
You have access to the current project context. Respond concisely and helpfully.
Provide practical, actionable project management guidance.

RESPONSE LENGTH RULE: When the user asks "what is X", "explain X", or any terminology/concept question,
respond in 200 words or fewer. Lead with a plain-English one-liner, then bullet-point the key facts.

PM AGENT PLATFORM TERMINOLOGY (use these definitions when users ask):
- PMB Snapshot: Performance Measurement Baseline — the approved combination of scope, schedule, and cost baselines locked at a point in time. It is the agreed "plan" that actual performance is measured against. Once created, the PMB Snapshot freezes the current requirements list, milestone dates, and budget (BAC). Any approved Change Request that alters scope or budget creates a new PMB version, preserving the audit trail. EVM metrics (SPI, CPI, VAC) compare actuals to the PMB.
- BAC (Budget at Completion): the total approved budget for the project.
- EVM: Earned Value Management — measures project performance by comparing planned value (PV), earned value (EV), and actual cost (AC). Key indices: CPI (cost efficiency), SPI (schedule efficiency), EAC (forecast at completion).
- Registers tab: RAID log — tracks Assumptions and Dependencies extracted from SOW/BRD. Risks and Issues have their own dedicated tabs.
- Scope Control tab: manages the project's requirement list; supports baseline creation and scope delta review when requirements change.
- Baseline tab: shows the PMB Snapshot history, changelog of scope/budget changes, and delta between baseline versions.
- Advisory (⚡): AI-generated suggestion for something the PM should address — not actual project data.`;

  const response = await callLLM(
    {
      model:     config.model,
      maxTokens: config.maxTokens,
      system,
      messages:  [{ role: "user", content: `Context: ${JSON.stringify(context, null, 2)}\n\nUser command: ${command}` }],
      agent:     "chat",
    },
    config
  );

  return response.text;
}

export async function askPortfolio(
  question: string,
  context: Record<string, unknown>,
  role: string
): Promise<string> {
  const roleGuidance: Record<string, string> = {
    pm: "The user is a Project Manager. Focus answers on their own projects: schedule/budget risk, next actions, drafting artifacts or stakeholder communications on their behalf.",
    pgm: "The user is a Program Manager overseeing a set of programs and their projects. Focus on cross-project patterns within their programs, at-risk projects needing intervention, escalations, and PM performance across the portfolio.",
    delivery_head: "The user is a Delivery/Practice Head (executive). Be concise and numbers-first. Lead with the bottom line (cost, risk, delivery health), flag anything needing executive decision, and quantify impact in dollars where possible.",
    admin: "The user is an org administrator with full visibility. Answer with portfolio-wide context, calling out governance or process gaps where relevant.",
  };

  const config = await resolveModel("portfolio_chat");
  const system = `You are the PM Agent portfolio copilot — a senior PMO AI embedded across a portfolio delivery platform.
${roleGuidance[role] ?? roleGuidance.pm}
You have access to live portfolio data (projects, health, budget, risks, issues, milestones) provided as context below.
Answer directly and concisely using only the data provided — never fabricate figures, names, or dates not present in context.
If asked to draft something (an email, a message, a summary), produce it ready to send/use.
If the answer requires data not present in context, say what's missing rather than guessing.
Use markdown formatting (bold, bullet lists) sparingly for readability in a chat UI.`;

  const response = await callLLM(
    {
      model:     config.model,
      maxTokens: config.maxTokens,
      system,
      messages:  [{ role: "user", content: `Portfolio context:\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${question}` }],
      agent:     "portfolio_chat",
    },
    config
  );

  return response.text;
}

function buildArtifactContent(
  artifactType: string,
  projectContext: Record<string, unknown>,
  requirements?: string,
  evidenceContext?: EvidenceContext,
  templateOverride?: ArtifactTemplateOverride
): { text: string }[] {
  const templates: Record<string, string> = {

    // ── INITIATING ────────────────────────────────────────────────────────────

    project_charter: `Generate a Project Charter.
CRITICAL: All milestone targetDates must fall within the project's startDate–endDate window from context. Reflect the stated methodology, engagement type, and billing model from context throughout.
Return JSON with:
- projectTitle (string)
- projectCode (string): short alphanumeric code
- version (string): "1.0"
- preparedBy (string): always exactly "PM Agent on behalf of the Project Manager": always exactly "PM Agent on behalf of the Project Manager"
- approvedBy (string): sponsor name
- date (string): ISO date
- projectStartDate (string): the project startDate from context
- projectEndDate (string): the project endDate from context
- projectDescription (string): clear, concise purpose statement
- businessCase (string): strategic problem or opportunity this project addresses
- objectives (array of strings): 3–5 SMART objectives — specific, measurable, achievable, relevant, time-bound
- successCriteria (array of {criterion, measure, target}): how success will be measured
- scope (object):
    inScope (array of strings): key deliverables explicitly included
    outOfScope (array of strings): explicit exclusions to prevent scope creep
- deliverables (array of strings): major project deliverables
- milestones (array of {name, targetDate, description}): targetDates within project window
- budget (object): {total (string), currency (string), fundingSource (string), contingencyReserve (string)}
- stakeholders (array of {name, role, organization, power (High/Medium/Low), interest (High/Medium/Low), engagementLevel (Unaware/Resistant/Neutral/Supportive/Leading), notes})
- risks (array of strings): top 3–5 high-level risks at initiation
- assumptions (array of strings)
- constraints (array of strings): budget, schedule, regulatory, resource
- pmAuthority (string): PM's authority level and decision-making scope
- approvalRequirements (string): what constitutes project approval
- approvalSignatures (array of {role, name})`,

    business_case: `Generate a Business Case.
Return JSON with:
- title (string)
- preparedBy (string): always exactly "PM Agent on behalf of the Project Manager"
- date (string)
- executiveSummary (string)
- problemStatement (string): the business problem or opportunity
- strategicAlignment (array of strings): how this aligns to organizational strategy
- options (array of {option, description, pros (array), cons (array), estimatedCost, estimatedBenefit, roi})
- recommendedOption (string): which option is recommended and why
- financialAnalysis (object): {npv (string), roi (string), paybackPeriod (string), totalCost (string), totalBenefit (string), currency (string)}
- nonFinancialBenefits (array of strings)
- risks (array of {description, probability (High/Medium/Low), impact (High/Medium/Low), mitigation})
- assumptions (array of strings)
- constraints (array of strings)
- recommendation (string): clear recommendation for approval`,

    stakeholder_register: `Generate a Stakeholder Register.
Return JSON with:
- stakeholders (array of {
    id (string): S001, S002…
    name (string)
    title (string)
    organization (string)
    category (string): Internal | External | Sponsor | Regulator | Vendor | Customer
    power (string): High | Medium | Low
    interest (string): High | Medium | Low
    quadrant (string): Manage Closely | Keep Satisfied | Keep Informed | Monitor
    currentEngagement (string): Unaware | Resistant | Neutral | Supportive | Leading
    desiredEngagement (string): Unaware | Resistant | Neutral | Supportive | Leading
    influenceStrategy (string): how to move them to desired engagement
    communicationNeeds (string): what information, how often, which channel
    notes (string)
  })
- powerInterestSummary (string): overall stakeholder landscape narrative`,

    initiation_deck: `Generate a Project Initiation Deck for CXO stakeholder presentation.
Return JSON with:
- projectTitle (string)
- projectDescription (string)
- date (string)
- sponsor (string)
- objectives (array of strings): 3–5 SMART objectives
- scope (object): {inScope (array of strings), outOfScope (array of strings)}
- deliverables (array of strings)
- milestones (array of {name, targetDate}): key milestones
- stakeholders (array of {name, role, interest})
- budget (string): order-of-magnitude budget with currency
- timeline (string): start to end date range
- risks (array of strings): top 5 risks only
- assumptions (array of strings)
- constraints (array of strings)
- governance (object): {sponsor (string), pm (string), steeringCommittee (string), reportingCadence (string)}
- approvalSignatures (array of {role})
- nextSteps (array of strings): immediate actions post-approval
- teamIntroduction (array of {name, role, expertise (array of strings, max 3 bullet points), email, availability (string, e.g. "100%" or "50%")}):
    If project resources are provided in the context, use them (map name, role, skills to the fields).
    Otherwise generate 5–7 placeholders using generic numbered roles (e.g. "Project Manager", "Technical Lead", "Business Analyst 1", "Developer 1", "QA Engineer 1").
    For placeholders, use "[Name TBD]" for name and "[email@company.com]" for email.
- raci (array of {activity (string), pm (string), technicalLead (string), ba (string), developer (string), qa (string), sponsor (string), client (string)}):
    Generate a RACI matrix for 10–12 key project activities covering initiation, planning, execution, testing, and closure.
    Each cell value must be one of: R (Responsible), A (Accountable), C (Consulted), I (Informed), or "—".
    Every row must have exactly one A. PM is typically Accountable for planning/reporting activities.
    Example activities: Project Kick-off, Requirements Gathering, Solution Architecture, Development Sprint Planning, Code Review, UAT Planning, UAT Sign-off, Risk Management, Status Reporting, Change Control, Go-Live Approval, Lessons Learned.
- escalationChannels (object):
    {
      internal (array of {level (string: "L1"/"L2"/"L3"), title (string), name (string), contact (string), responseTime (string: e.g. "4 hours"), description (string)}): 3 levels — L1=Project Manager, L2=Delivery Head/Program Manager, L3=Executive Sponsor,
      vendor (array of {level (string: "L1"/"L2"/"L3"), title (string), name (string), contact (string), responseTime (string), description (string)}): 3 vendor escalation levels — L1=Vendor Project Manager, L2=Vendor Account Manager, L3=Vendor Executive,
      guidelines (array of strings): 4 clear escalation guidelines (when to escalate, expected behaviour, SLA expectations)
    }
    Use the governance object's pm and sponsor fields if available. Use generic placeholders like "[PM Name]", "[Account Manager]" where names are unknown.`,

    assumption_log: `Generate an Assumption Log.
Return JSON with:
- assumptions (array of {
    id (string): A001, A002…
    description (string): clear assumption statement
    category (string): Technical | Business | Resource | External | Schedule | Cost
    owner (string)
    dateIdentified (string)
    validationMethod (string): how this will be confirmed
    validationDate (string): when it will be validated
    status (string): Open | Validated | Invalid | Deferred
    impactIfWrong (string): consequence if assumption proves false
    notes (string)
  })`,

    benefits_register: `Generate a Benefits Register.
Return JSON with:
- benefits (array of {
    id (string): B001, B002…
    name (string)
    description (string)
    type (string): Financial | Strategic | Operational | Customer | Compliance | Employee
    owner (string): who is accountable for realizing this benefit
    baseline (string): current state measurement
    target (string): expected post-project measurement
    unit (string): metric unit (%, $, score, count)
    targetDate (string): when benefit is expected to be realized
    trackingMethod (string): how it will be measured
    dependencies (string): what must be true to realize this benefit
    status (string): Planned | On Track | At Risk | Realized | Not Realized
    notes (string)
  })`,

    // ── PLANNING ─────────────────────────────────────────────────────────────

    scope_statement: `Generate a Scope Statement.
Return JSON with:
- projectName (string)
- version (string)
- approvedBy (string)
- date (string)
- projectObjectives (array of strings): measurable objectives
- productScope (string): description of the product, service, or result
- projectScope (string): work that must be done to deliver it
- deliverables (array of {name, description, acceptanceCriteria})
- inScope (array of strings): explicitly included
- outOfScope (array of strings): explicitly excluded to prevent scope creep
- assumptions (array of strings)
- constraints (array of strings)
- dependencies (array of strings): external dependencies
- acceptanceCriteria (string): overall project acceptance criteria
- approvalRequirements (string)`,

    wbs: `Generate a Work Breakdown Structure.

RULE 1 — Deliverable-oriented decomposition: every element is a noun/noun-phrase outcome (a thing produced), never a verb or activity (e.g. "Tested Application" not "Test Application").

RULE 2 — 100% Rule (mandatory at every level):
  - The phases must collectively cover 100% of the total project scope — no scope gap, no scope outside the project.
  - The deliverables within each phase must collectively cover 100% of that phase's scope.
  - The work packages within each deliverable must collectively cover 100% of that deliverable's scope.
  Never add scope that does not belong to the parent; never omit scope that does.

RULE 3 — Mandatory phase:
  - For WATERFALL: include a "Project Management" phase covering: Project Charter, Project Management Plan, Project Schedule, Risk Register, Status Reports, Lessons Learned.
  - For AGILE/SCRUM: replace "Project Management" with an "Agile Governance & Scrum Ceremonies" phase owned by the Scrum Master. This phase MUST include deliverables and work packages for:
      Product Backlog (Product Backlog Refinement Sessions, Definition of Done Document, User Story Map)
      Sprint Cadence (Sprint Planning Meetings, Sprint Review Presentations, Sprint Retrospective Outputs, Daily Scrum Facilitation)
      Agile Reporting (Sprint Velocity Reports, Burndown Charts, Release Burnup Charts)
      Project Administration (Project Charter, Risk Register, Stakeholder Register, Lessons Learned)
    The Scrum Master must be the owner of Sprint Cadence deliverables; the Product Owner owns the Product Backlog.

RULE 4 — Role naming: ALL owner fields MUST use functional role titles — never individual person names, client-system-specific names, or numbered placeholders.
  Core roles: Project Manager, Product Owner, Scrum Master, Business Analyst, Technical Lead, Solution Architect, Senior Developer, Developer, QA Engineer, Test Manager, DevOps Engineer.
  Specialist roles where relevant: Process Analyst, Risk Manager, Change Manager, Data Analyst, Security Analyst, Integration Specialist, Business Process Owner, UAT Coordinator, Infrastructure Engineer, Compliance Analyst, Cloud Architect, UX Designer, Database Administrator.
  Never use product-specific names (e.g. "PACS Engineer", "SAP Consultant" — use "Integration Specialist" or "ERP Analyst" instead).

RULE 5 — Duration constraint: calibrate ALL estimatedDays so the total WBS scope fits within the project startDate–endDate window. The sum of all work-package estimatedDays must not exceed the total working days (Mon–Fri) in that window.

RULE 6 — Agile phases: For AGILE/SCRUM projects, structure phases around Sprint releases or feature epics, NOT traditional waterfall phases (no "Design → Build → Test → Deploy" sequence). Use outcome-oriented phase names such as "Foundation Sprint Outputs", "Core Feature Releases", "Integration & Performance Releases", "UAT & Go-Live Release". Each sprint-phase deliverable represents a potentially shippable increment.

Return JSON with:
- projectName (string)
- phases (array of phases):
  {
    id (string): "1.1", "1.2" …
    name (string): deliverable-oriented phase name
    owner (string): functional role title (e.g. "Technical Lead")
    deliverables (array):
      {
        id (string): "1.1.1" …
        name (string): deliverable name
        owner (string): functional role title
        workPackages (array):
          {
            id (string): "1.1.1.1" …
            name (string): work package name
            estimatedDays (number)
            owner (string): functional role title (e.g. "Developer", "Business Analyst")
            dependencies (array of strings): WBS codes this work package depends on — omit or leave empty if none
          }
      }
  }`,

    milestone_plan: `Generate a Milestone Plan.
CRITICAL: Use the project's startDate and endDate from the Project Context as this plan's startDate and endDate. All milestone plannedDates must fall strictly between those two dates.
Return JSON with:
- projectName (string)
- startDate (string): the project startDate from context — do not invent a different date
- endDate (string): the project endDate from context — do not invent a different date
- baselineDate (string): when baseline was set
- milestones (array of {
    id (string): M001, M002…
    name (string)
    description (string)
    phase (string)
    plannedDate (string): ISO date — baseline
    forecastDate (string): current forecast
    actualDate (string | null)
    status (string): Not Started | On Track | At Risk | Slipped | Complete
    isCritical (boolean): true if on critical path
    deliverables (array of strings): what is produced at this milestone
    owner (string): generic project role ONLY — e.g. "Project Manager", "Technical Lead", "Delivery Manager", "Business Analyst", "Scrum Master". NEVER client names, company names, external organisation names, or individual person names
    predecessors (array of strings): milestone IDs this depends on
    variance (string): e.g. "+3 days" or "On schedule"
    notes (string)
  })
- criticalPathSummary (string): description of the critical path
- schedulePerformanceIndex (string): SPI if data available, else "TBD"`,

    resource_plan: `Generate a Resource Management Plan.
CRITICAL RULES:
1. The project context includes a wbsStructure field. Extract EVERY unique role that appears as an owner in the WBS phases, deliverables, and work packages. Every WBS role MUST appear in the teamDirectory — do not drop any.
2. All team member startDate/endDate values must align to the project's startDate/endDate from context.
3. Use the exact functional role titles from the WBS — never numbered placeholders (e.g. "Developer 1") and never client-system-specific names.
4. Estimate allocationPercent and duration for each role based on the volume and nature of their WBS work packages.
Return JSON with:
- projectName (string)
- teamDirectory (array of {
    id (string): R001, R002…
    name (string): use the functional role title as the name (e.g. "Business Analyst", "Risk Manager")
    role (string)
    department (string)
    skills (array of strings)
    allocationPercent (number): 0-100
    startDate (string): within project timeline
    endDate (string): within project timeline
    location (string)
    dailyRate (number | null): optional
    currency (string)
    notes (string)
  })
- resourceCalendar (object): {workingDays (array of strings), holidays (array of strings), notes (string)}
- skillsMatrix (array of {skill, required (boolean), team members who have it (array of strings)})
- resourceConstraints (array of strings)
- trainingNeeds (array of {role, skill, trainingType, targetDate})`,

    cost_plan: `Generate a Cost Management Plan and Budget.
Return JSON with:
- projectName (string)
- currency (string)
- estimatingMethod (string): Bottom-Up | Analogous | Parametric | Three-Point
- laborEstimates (array of {
    role (string)
    resource (string)
    phase (string)
    estimatedDays (number)
    dailyRate (number)
    totalCost (number)
    basisOfEstimate (string)
  })
- nonLaborCosts (array of {category (string), description (string), amount (number), phase (string)})
- costSummary (object): {
    totalLaborCost (number)
    totalNonLaborCost (number)
    subtotal (number)
    contingencyReserve (number): for known-unknown risks (typically 10-20%)
    costBaseline (number): subtotal + contingency reserve
    managementReserve (number): for unknown-unknown risks (typically 5-10%)
    totalBudget (number): BAC — Budget at Completion
  }
- phaseBreakdown (array of {phase, plannedValue (number), cumulativePV (number)})
- evmSetup (object): {
    bac (number): Budget at Completion
    plannedValueByPeriod (array of {period (string), pv (number), cumulativePV (number)})
    earningRule (string): e.g. "0/100 for work packages under 2 weeks"
    reportingCadence (string)
  }
- fundingRequirements (array of {period (string), amount (number), cumulativeAmount (number)})`,

    raid_register: `Generate a RAID Register covering Risks, Assumptions, Issues, and Dependencies.
Generate at most 5 risks, 5 assumptions, 4 issues, and 4 dependencies — focus on the most significant items only.
Return JSON with:
- risks (array of {
    id (string): R001, R002…
    category (string): Technical | Schedule | Cost | Resource | External | Organizational | Quality
    statement (string): one concise sentence — "If [cause], then [event], causing [effect]"
    probability (string): Very Low | Low | Medium | High | Very High
    impact (string): Very Low | Low | Medium | High | Very High
    riskScore (number): map probability/impact to 2/4/6/8/10 then multiply (max 100)
    severity (string): Low (1-15) | Medium (16-35) | High (36-59) | Critical (60-100)
    strategy (string): Avoid | Transfer | Mitigate | Accept
    responseActions (array of strings): 1-2 concise steps
    owner (string): generic project role (e.g. "Project Manager") — NOT a personal name; "To Be Assigned" if unknown
    status (string): Open | In Progress | Closed | Accepted
    dueDate (string)
    requirementRef (string): most relevant scopeRequirement key (e.g. "REQ-001"), or "General"
  })
- assumptions (array of {
    id (string): A001…
    description (string)
    category (string): Technical | Business | Resource | External
    owner (string): generic project role name or "To Be Assigned"
    validationDate (string)
    status (string): Open | Validated | Invalid
    impactIfWrong (string)
  })
- issues (array of {
    id (string): I001…
    description (string)
    category (string): Scope | Schedule | Cost | Quality | Resource | Technical | Vendor
    severity (string): Critical | High | Medium | Low
    rootCause (string)
    owner (string): generic project role name or "To Be Assigned"
    resolutionPlan (string)
    targetResolutionDate (string)
    status (string): Open | In Progress | Escalated | Resolved | Closed
  })
- dependencies (array of {
    id (string): D001…
    description (string)
    type (string): Internal | External | Technical | Organizational
    dependsOn (string): what this depends on
    owner (string)
    expectedDate (string)
    impactIfDelayed (string)
    status (string): On Track | At Risk | Delayed | Resolved
  })`,

    risk_register: `Generate a Risk Register. Generate 5 to 8 risks maximum — prioritise the most critical and distinct risks only.
Return JSON with:
- risks (array of {
    id (string): R001, R002…
    category (string): Technical | Schedule | Cost | Resource | External | Organizational | Quality | Procurement
    statement (string): one concise sentence — "If [cause], then [event], causing [effect]"
    probability (string): Very Low | Low | Medium | High | Very High
    impact (string): Very Low | Low | Medium | High | Very High
    riskScore (number): map probability and impact to 2/4/6/8/10 then multiply (max 100)
    severity (string): Low (1-15) | Medium (16-35) | High (36-59) | Critical (60-100)
    strategy (string): Avoid | Transfer | Mitigate | Accept | Exploit | Enhance
    responseActions (array of strings): 1-2 concise actionable steps
    owner (string): generic project role (e.g. "Project Manager", "Technical Lead") — NOT a personal name; "To Be Assigned" if unknown
    status (string): Open | In Progress | Closed | Accepted
    dueDate (string): ISO date or null
    requirementRef (string): trace to the most relevant scopeRequirement key (e.g. "REQ-001"); use "General" only if not traceable
  })`,

    communication_plan: `Generate a Communications Management Plan.
Apply the communications channels formula: n(n−1)/2.
Return JSON with:
- projectName (string)
- stakeholderCount (number)
- communicationChannels (number): n(n-1)/2
- communicationItems (array of {
    id (string): C001…
    name (string): e.g. "Weekly Status Report", "Steering Committee Deck", "Risk Review"
    type (string): Status Report | Escalation | Meeting | Dashboard | Newsletter | Ad Hoc
    audience (string): who receives this
    purpose (string): why this communication exists
    frequency (string): Daily | Weekly | Bi-weekly | Monthly | Quarterly | As Needed | Milestone-triggered
    channel (string): Email | Teams/Slack | Meeting | SharePoint | Dashboard | Report
    format (string): PPTX | XLSX | Email | Verbal | Dashboard
    owner (string): who produces/sends it
    escalationPath (string): if this communication triggers an action
    notes (string)
  })
- meetingCadence (array of {meeting, attendees (array), frequency, duration, owner, agenda (array of strings)})`,

    raci_matrix: `Generate a RACI Matrix — Responsibility Assignment Matrix.
CRITICAL RULES: (1) Exactly ONE Accountable (A) per activity — two A's means none. (2) At least one Responsible (R) per activity. (3) R/A/C/I only in role cells.
Return JSON with:
- projectName (string)
- roles (array of strings): all project roles e.g. ["Sponsor", "PM", "BA", "Tech Lead", "Developer", "QA Lead", "Change Manager", "Steering Committee"]
- activities (array of {
    id (string): T001…
    activity (string): deliverable or activity name
    phase (string)
    roles (object): keys = role names, values = "R" | "A" | "C" | "I" | "-"
    notes (string)
  })
- teamDirectory (array of {
    id (string)
    name (string)
    role (string)
    department (string)
    allocationPercent (number)
    location (string)
    contact (string)
  })
- raciSummary (object): {activitiesCount, rolesCount, accountabilityCheck (string): "Pass" if every activity has exactly one A}`,

    quality_plan: `Generate a Quality Management Plan.
Return JSON with:
- projectName (string)
- qualityPolicy (string): project quality policy statement
- qualityObjectives (array of strings)
- qualityStandards (array of {standard, applicableTo, reference})
- qualityMetrics (array of {
    metric (string)
    definition (string)
    unit (string)
    baseline (string)
    target (string)
    measurementMethod (string)
    frequency (string)
    owner (string)
  })
- qaActivities (array of {activity, purpose, frequency, owner, method})
- qcCheckpoints (array of {phase, checkpoint, criteria, method, owner, deliverable})
- defectManagement (object): {process (string), severity levels (array of {level, definition, responseTime}), tools (string)}
- continuousImprovement (string)`,

    project_mgmt_plan: `Generate a Project Management Plan — the master governing document for this project.
IMPORTANT: Keep every string field to ONE concise sentence. Arrays: max 4 items each.
Return JSON with exactly these keys in this order:
- projectOverview: { name, code, version:"1.0", sponsor, pm, startDate, endDate, budget, description (1 sentence), objectives (≤4 strings), successCriteria (≤4 strings) }
- scopeManagement: { scopeStatement (1 sentence), inScope (≤4 strings), outOfScope (≤3 strings), wbsApproach (1 sentence) }
- changeManagement: { process (1 sentence), authority (e.g. "PM <1%; Sponsor 1–5%; Steering Committee >5%"), impactThresholds (≤3 of {category, threshold, approver}) }
- riskManagement: { approach (1 sentence), riskCategories (≤4 strings), reviewCadence, topRisks (≤3 of {risk, probability, impact, mitigation (1 sentence)}) }
- costManagement: { estimatingMethod, controlMethod, varianceThreshold (e.g. "±5% CPI triggers corrective action"), contingencyReserve, earnedValueApproach (1 sentence) }
- qualityManagement: { qualityPolicy (1 sentence), standards (≤3 strings), qaApproach (1 sentence) }
- scheduleManagement: { methodology, tooling, baselineApproach (1 sentence), varianceThreshold (e.g. "±10% SPI triggers recovery plan"), keyMilestones (≤4 of {milestone, plannedDate, owner}) }
- resourceManagement: { teamStructure (1 sentence), keyRoles (≤4 of {role, responsibility}), acquisitionApproach (1 sentence) }
- communicationsManagement: { approach (1 sentence), communicationItems (≤4 of {audience, information, frequency, channel}), escalationPath (1 sentence) }
- stakeholderManagement: { engagementStrategy (1 sentence), keyStakeholders (≤4 of {name, role, engagementLevel}), reportingCadence }
- keyAssumptions (≤4 strings)
- keyDependencies (≤4 strings)
- keyConstraints (≤4 strings)
- approvalSignatures (≤3 of {role, name, date})`,

    // ── EXECUTION ─────────────────────────────────────────────────────────────

    evm_analysis: `Generate a full Earned Value Management (EVM) Analysis.

INPUTS available in project context:
- budget = BAC (Budget at Completion) — this is the CURRENT approved budget (may have been revised via CRs)
- budgetRevisions = array of {previousBudget, newBudget, delta, reason, createdAt} — CR-approved budget changes, oldest first; if present, the original contract BAC is budgetRevisions[0].previousBudget
- startDate / endDate = planned duration
- costEntries = array of {date, amount, category} — these are the actual costs (AC) logged per date
- milestones = planned milestone dates for schedule context

COMPUTATION RULES (mandatory — follow exactly):
1. Group costEntries by calendar month to form per-period AC values.
2. PV per period = BAC × (elapsed months / total planned months). Use linear interpolation; note if plan appears non-linear.
3. EV per period = BAC × estimated % complete. Derive % complete from milestones achieved vs total, or from cost-to-date ratio relative to plan if no milestone data. State your derivation method.
4. For each period compute cumulative: PV, EV, AC, SV (EV-PV), CV (EV-AC), SPI (EV/PV), CPI (EV/AC), SV%, CV%.
5. Use CUMULATIVE CPI of the latest period for forecasts — never average period CPIs.
6. Forecasts (latest period): EAC = BAC/CPI, ETC = EAC-AC, SAC = planned_months/SPI, VAC_cost = BAC-EAC, VAC_schedule = planned_months-SAC, TCPI = (BAC-EV)/(BAC-AC).
7. RAG: Green = CPI≥0.95 AND SPI≥0.95; Amber = either index 0.85–0.95; Red = either index <0.85 OR TCPI>1.10.
8. Sanity-check: sign of SV must agree with SPI vs 1; sign of CV must agree with CPI vs 1; EAC>BAC iff CPI<1.

Return JSON:
- projectName (string)
- analysisDate (string): ISO date of analysis (today)
- bac (number): Budget at Completion
- plannedDurationMonths (number)
- currency (string)
- derivationMethod (string): explain how EV % complete was derived
- periods (array of {
    period (string): "YYYY-MM",
    periodLabel (string): "Month N — Mon YYYY",
    pv (number), ev (number), ac (number),
    sv (number), cv (number),
    spi (number), cpi (number),
    svPct (number), cvPct (number),
    cumPv (number), cumEv (number), cumAc (number),
    cumSv (number), cumCv (number),
    cumSpi (number), cumCpi (number)
  })
- originalBac (number): budgetRevisions[0].previousBudget if revisions exist, else same as bac
- budgetRevisionCount (number): number of approved CR budget revisions
- forecast (object): {
    eac (number), etc (number), sac (number),
    vacCost (number), vacSchedule (number), tcpi (number),
    projectedEndDate (string): ISO date derived from SAC,
    ragStatus (string): "Green" | "Amber" | "Red"
  }
- verdict (object): {
    costHealth (string): plain-language cost status — over/on/under budget, % and absolute variance, projected overrun at completion,
    scheduleHealth (string): plain-language schedule status — behind/on/ahead, projected finish vs planned,
    recoveryOutlook (string): TCPI interpretation — is recovery realistic? If TCPI>1.10 say so explicitly,
    recommendedActions (array of string): 2-4 concrete PM actions
  }
- interpretationTable (array of {metric, formula, value, interpretation}): one row each for SV, CV, SPI, CPI, EAC, ETC, SAC, VAC cost, VAC schedule, TCPI`,

    traceability_matrix: `Generate a Requirements Traceability Matrix (RTM) per IEEE 830.
CRITICAL: Every requirement MUST be sourced ONLY from the requirements document provided below. Do NOT invent requirements.
Map each requirement forward to: WBS/deliverable → schedule milestone → acceptance criteria → test/validation approach.

Return JSON with:
- projectName (string)
- documentVersion (string): "1.0"
- preparedDate (string): ISO date
- summary (object): {
    totalRequirements (number),
    functional (number),
    nonFunctional (number),
    businessRules (number),
    fullyTraced (number),
    partiallyTraced (number),
    notTraced (number)
  }
- requirements (array of {
    id (string): REQ-001, REQ-002… — sequential
    category (string): Functional | Non-Functional | Business Rule | Constraint | Interface | Security | Performance | Compliance
    source (string): exact section/page reference from the requirements document (e.g. "Section 3.2", "Page 5")
    requirementStatement (string): verbatim or faithfully paraphrased requirement from the source doc — NEVER fabricated
    priority (string): Must Have | Should Have | Could Have | Won't Have (MoSCoW)
    complexity (string): Low | Medium | High
    wbsRef (string): mapped WBS code or deliverable name from project context (e.g. "1.2.3 Authentication Module")
    milestone (string): linked milestone name from project context
    deliverable (string): specific deliverable this requirement maps to
    acceptanceCriteria (string): measurable, testable criterion — how the PM/customer will verify this is met
    validationMethod (string): Inspection | Testing | Demonstration | Analysis | Review
    owner (string): team or role responsible for implementing this requirement
    status (string): Not Started | In Progress | Implemented | Verified | Accepted
    traceabilityStatus (string): Fully Traced | Partially Traced | Not Traced
    notes (string): gaps, risks, or dependencies related to this requirement
  })
- traceabilityGaps (array of {
    gapId (string): GAP-001…
    description (string): what is missing or not covered
    impact (string): High | Medium | Low
    recommendation (string): what should be done to close the gap
  })
- changeHistory (array of {
    version (string),
    date (string),
    changedBy (string),
    description (string)
  })`,

    action_log: `Generate an Action Log for project execution tracking.
Return JSON with:
- actions (array of {
    id (string): ACT001…
    description (string): clear action statement
    category (string): Decision | Risk | Issue | Dependency | Technical | Process | Stakeholder
    priority (string): Critical | High | Medium | Low
    owner (string): single named owner
    raisedBy (string)
    dateRaised (string)
    dueDate (string)
    completedDate (string | null)
    status (string): Open | In Progress | Blocked | Complete | Cancelled
    relatedArtifact (string): e.g. "Risk R003", "Issue I007"
    notes (string)
  })`,

    issue_register: `Generate an Issue Register.
Return JSON with:
- issues (array of {
    id (string): ISS001…
    title (string)
    description (string)
    category (string): Scope | Schedule | Cost | Quality | Resource | Technical | Vendor | Stakeholder
    severity (string): Critical | High | Medium | Low
    impact (string): business impact if not resolved
    rootCause (string)
    raisedBy (string)
    dateRaised (string)
    owner (string): single named owner accountable for resolution
    resolutionPlan (string): specific steps to resolve
    targetResolutionDate (string)
    actualResolutionDate (string | null)
    escalationPath (string): who to escalate to if unresolved
    status (string): Open | In Progress | Escalated | Resolved | Closed
    resolution (string | null): how it was resolved
    lessonsLearned (string | null)
  })`,

    decision_log: `Generate a Decision Log.
Return JSON with:
- decisions (array of {
    id (string): DEC001…
    title (string)
    description (string): what was decided
    category (string): Technical | Commercial | Resource | Scope | Risk | Process | Vendor
    context (string): what triggered this decision
    alternativesConsidered (array of {option, pros, cons})
    decisionMade (string): the chosen option
    rationale (string): why this option was chosen
    decidedBy (string): person or body that made the decision
    dateDecided (string)
    impactOnBaselines (object): {scope (string), schedule (string), cost (string), risk (string)}
    owner (string): responsible for implementing
    implementationDeadline (string)
    reviewDate (string | null)
    status (string): Pending | Approved | Implemented | Superseded
    notes (string)
  })`,

    // ── MONITORING & CONTROLLING ───────────────────────────────────────────────

    weekly_status: `Generate a Weekly Status Report.
Apply EVM principles where data is available.
Return JSON with:
- reportingPeriod (string): e.g. "Week of 07 Jul 2026"
- reportDate (string)
- preparedBy (string): always exactly "PM Agent on behalf of the Project Manager"
- overallStatus (string): green | amber | red
- ragScorecard (object): {
    schedule (object): {status (string): green|amber|red, reason (string)}
    cost (object): {status (string): green|amber|red, reason (string)}
    scope (object): {status (string): green|amber|red, reason (string)}
    quality (object): {status (string): green|amber|red, reason (string)}
    risk (object): {status (string): green|amber|red, reason (string)}
  }
- executiveSummary (string): 3–4 sentences, lead with overall health then the key signal
- accomplishments (array of strings): 3–5 completed items this period
- plannedActivities (array of strings): 3–5 planned for next period
- milestoneStatus (array of {name, plannedDate, forecastDate, status (On Track|At Risk|Slipped|Complete)})
- risks (array of {id, description, status, action}): top 3 active risks
- issues (array of {id, description, owner, targetDate, status})
- financialStatus (object): {budgetToDate (string), actualSpend (string), variance (string), cpi (string), spi (string), forecastAtCompletion (string)}
- resourceStatus (string): team availability and any resource constraints
- decisions (array of strings): decisions made or needed from leadership
- nextPeriodDependencies (array of strings): what is needed to proceed`,

    monthly_status: `Generate a Monthly Status Report.
Include EVM metrics and benefits tracking.
Return JSON with:
- reportingPeriod (string): e.g. "July 2026"
- reportDate (string)
- preparedBy (string): always exactly "PM Agent on behalf of the Project Manager"
- overallStatus (string): green | amber | red
- ragScorecard (object): {
    schedule (object): {status, reason}
    cost (object): {status, reason}
    scope (object): {status, reason}
    quality (object): {status, reason}
    risk (object): {status, reason}
    benefits (object): {status, reason}
  }
- executiveSummary (string): concise executive narrative
- keyAchievements (array of strings): top 3–5 achievements this month
- kpis (object): {
    spi (string): Schedule Performance Index
    cpi (string): Cost Performance Index
    budgetSpent (string)
    budgetRemaining (string)
    forecastAtCompletion (string): EAC
    varianceAtCompletion (string): VAC
    percentComplete (string)
    teamUtilisation (string)
    openRisks (number)
    openIssues (number)
  }
- milestoneStatus (array of {name, plannedDate, forecastDate, status})
- risks (array of {id, description, impact, probability, strategy, status})
- issues (array of {id, description, severity, owner, targetDate, status})
- nextMonthPlan (array of strings): planned activities
- benefitsStatus (array of {benefit, target, currentStatus}): benefits realization tracking
- decisions (array of strings): decisions made this period
- escalations (array of strings): items requiring leadership intervention
- changeRequests (array of {id, description, status})`,

    change_log: `Generate a Change Control Register.
A change must never touch a baseline without an approved CR.
Return JSON with:
- projectName (string)
- ccbMembers (array of {name, role, approvalThreshold (string)})
- approvalThresholds (object): {pmAuthority (string), sponsorAuthority (string), ccbAuthority (string)}
- changeRequests (array of {
    id (string): CR001…
    dateRaised (string)
    requestedBy (string)
    category (string): Scope | Schedule | Cost | Quality | Resource | Technical | Regulatory | Contract
    title (string)
    description (string)
    justification (string)
    impactAnalysis (object): {
      scopeDelta (string)
      scheduleDelta (string): e.g. "+5 days"
      costDelta (string): e.g. "+$15,000"
      qualityImpact (string)
      riskImpact (string)
      resourceImpact (string)
    }
    priority (string): Critical | High | Medium | Low
    ccbDecision (string): Approved | Rejected | Deferred | Under Review
    decisionDate (string)
    decisionRationale (string)
    owner (string)
    implementationDeadline (string)
    baselineUpdated (boolean)
    status (string): Submitted | Under Review | Approved | Rejected | Deferred | Implemented | Closed
    notes (string)
  })`,

    // ── CLOSING ───────────────────────────────────────────────────────────────

    lessons_learned: `Generate a Lessons Learned Register.
Return JSON with:
- projectName (string)
- facilitatedBy (string)
- date (string)
- lessons (array of {
    id (string): LL001…
    category (string): Scope | Schedule | Cost | Quality | Risk | Team | Process | Vendor | Stakeholder | Technology
    phase (string): which project phase this lesson applies to
    situation (string): what happened — factual context
    whatWorked (string | null): positive lesson
    whatToImprove (string | null): improvement lesson
    rootCause (string): why did this happen
    impact (string): effect on project objectives
    recommendation (string): specific, actionable recommendation — not vague "communicate better"
    reusableAsset (string): template, process, or checklist that should be created/updated
    adoptionOwner (string): who will implement the recommendation
    targetDate (string)
    applicableProjectTypes (array of strings)
  })
- overallSummary (object): {topSuccesses (array of strings), topImprovements (array of strings), processRecommendations (array of strings)}`,

    dependencies_register: `Generate a Dependencies Register.
Track all project dependencies — internal deliverables, external third parties, technical integrations, and commercial obligations.
Return JSON with:
- dependencies (array of {
    id (string): e.g. DEP-001
    description (string): what this project depends on
    type (string): internal | external | technical | commercial
    dependentOn (string): name of team, system, or party
    owner (string): who manages this dependency
    expectedDate (string): YYYY-MM-DD or milestone name
    status (string): open | resolved | at-risk
    impact (string): what is blocked if this is not met
    mitigationAction (string): fallback or contingency
  })`,

    quarterly_business_review: `Generate a Quarterly Business Review (QBR) presentation following delivery governance best practices.
This is a structured executive review delivered to the client each quarter.
Return JSON with:
- quarter (string): e.g. Q3 2025
- projectName (string)
- executiveSummary (string): one-paragraph health narrative
- ragStatus (string): Green | Amber | Red
- milestoneReview (array of {milestone, planned (date), forecast (date), status (On Track|At Risk|Delayed|Complete)})
- budgetSummary (object): {budget, actualToDate, forecastAtCompletion, variance, variancePercent}
- schedulePerformance (object): {spi, cumulativeSpi, trend (Improving|Stable|Declining), commentary}
- costPerformance (object): {cpi, cumulativeCpi, trend, commentary}
- keyRisks (array of {id, description, severity, owner, mitigation})
- keyIssues (array of {id, description, severity, owner, resolutionPlan})
- decisions (array of {description, owner, dueDate})
- nextQuarterPlan (array of {milestone, targetDate, owner})
- clientActions (array of {action, owner, dueDate})
- closingNotes (string)`,

    closure_report: `Generate a Project Closure Report.
Confirm benefits against the business case, not just on-time/on-budget.
Return JSON with:
- projectName (string)
- projectCode (string)
- sponsor (string)
- pm (string)
- closureDate (string)
- executiveSummary (string): outcome vs. objectives in one paragraph
- objectivesScorecard (array of {
    objective (string)
    target (string)
    actual (string)
    verdict (string): Met | Partially Met | Not Met
    evidence (string)
  })
- budgetPerformance (object): {
    bac (string): Budget at Completion — original approved budget
    actualCost (string)
    variance (string)
    variancePercent (string)
    cpi (string)
    explanation (string)
  }
- schedulePerformance (object): {
    plannedEndDate (string)
    actualEndDate (string)
    variance (string)
    spi (string)
    explanation (string)
  }
- deliverables (array of {name, status (Delivered|Partial|Not Delivered), acceptedBy, acceptanceDate, notes})
- benefitsRealized (array of {benefit, target, actual, status (Realized|Partial|Not Realized), notes})
- openItems (array of {description, owner, targetDate, type (Risk|Action|Warranty|Transition)})
- teamRecognition (array of strings): acknowledgements
- transitionToOps (object): {handoverTo (string), handoverDate (string), supportPeriod (string), notes (string)}
- closureSignatures (array of {role, name, date})`,
  };

  const schema = templates[artifactType]
    ?? `Generate a ${artifactType.replace(/_/g, " ")} artifact following project management best practices. Return structured JSON.`;

  const evidenceBlock = evidenceContext?.hasEvidence
    ? formatEvidenceForPrompt(evidenceContext)
    : "";

  const dynamicContext = `Project Context:\n${JSON.stringify(projectContext, null, 2)}\n\n${evidenceBlock}${requirements && !evidenceContext?.hasEvidence ? `Requirements / Source Document Content:\n${requirements}\n\n` : ""}`;

  // Build a mandatory alignment instruction derived from the project context so that
  // generated artifacts reference the correct dates, methodology, and engagement framing.
  const pStart = projectContext.startDate ? String(projectContext.startDate).slice(0, 10) : null;
  const pEnd   = projectContext.endDate   ? String(projectContext.endDate).slice(0, 10)   : null;
  const methodologyLabels: Record<string, string> = {
    waterfall: "Waterfall", agile: "Agile/Scrum", agile_scrum: "Agile/Scrum",
    kanban: "Kanban", safe: "SAFe", hybrid: "Hybrid Agile",
  };
  const engagementTypeLabels: Record<string, string> = {
    application_development: "Application Development", product_development: "Product Development",
    consulting: "Consulting", implementation: "Implementation", migration: "Migration", transformation: "Transformation",
  };
  const billingLabels: Record<string, string> = {
    fixed_price: "Fixed Price", time_and_material: "Time & Material",
    managed_services: "Managed Services", staff_aug: "Staff Augmentation",
  };
  const alignLines: string[] = [];
  if (pStart || pEnd) {
    alignLines.push(
      `Project timeline: ${pStart ?? "TBD"} → ${pEnd ?? "TBD"}. ` +
      `ALL date fields, phases, milestones, and resource start/end dates MUST fall within this window. ` +
      `Use these exact values wherever the artifact returns a project startDate or endDate.`
    );
  }
  if (projectContext.methodology) {
    const ml = methodologyLabels[String(projectContext.methodology)] ?? String(projectContext.methodology);
    alignLines.push(`Methodology: ${ml}. Align all phases, ceremonies, terminology, planning cadence, and artifact structure to this methodology.`);
  }
  if (projectContext.engagementType) {
    const et = engagementTypeLabels[String(projectContext.engagementType)] ?? String(projectContext.engagementType).replace(/_/g, " ");
    alignLines.push(`Engagement type: ${et}. Tailor scope, deliverables, and team structure to this type of engagement.`);
  }
  if (projectContext.engagementMode) {
    const bl = billingLabels[String(projectContext.engagementMode)] ?? String(projectContext.engagementMode).replace(/_/g, " ");
    alignLines.push(`Billing model: ${bl}. Reflect this in cost estimates, resource rates, and any contractual or commercial sections.`);
  }
  const alignmentBlock = alignLines.length > 0
    ? `\nMANDATORY PROJECT ALIGNMENT — apply to every field:\n${alignLines.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  // When a client template is active, its instructions lead the prompt so Claude
  // applies them before locking in the schema's default field list.
  const taskBlock = templateOverride?.userAddendum
    ? `Task: Generate a ${artifactType.replace(/_/g, " ")} for this project.
${alignmentBlock}
MANDATORY CLIENT-SPECIFIC REQUIREMENTS (apply these first — they override defaults):
${templateOverride.userAddendum}

Output format — produce a JSON object conforming to this schema:
${schema}

Return the artifact as valid JSON wrapped in \`\`\`json ... \`\`\` code blocks.`
    : `Task: ${schema}
${alignmentBlock}
Return the artifact as valid JSON wrapped in \`\`\`json ... \`\`\` code blocks.`;

  return [
    { text: taskBlock },
    { text: dynamicContext },
  ];
}

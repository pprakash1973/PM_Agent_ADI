"use client";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toaster";
import { Loader2, Wand2, ArrowLeft, Upload, CheckCircle2, X, AlertTriangle, User, ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type Mode = "upload" | "nl";

interface UploadedDoc {
  docId: string;
  file: File;
  status: "parsing" | "done" | "error";
  summary: string[];
  errorMsg?: string;
  parsed?: {
    requirementsText: string;
    requirementsFileName: string;
    requirementsFileFormat: string;
    requirementsExtracted: Record<string, unknown>;
    sowAssumptions: string[];
    sowDependencies: { description: string; type: string; owner?: string }[];
  };
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf"].includes(ext)) return <span className="text-red-500 font-bold text-xs bg-red-50 border border-red-200 rounded px-1.5 py-0.5">PDF</span>;
  if (["doc", "docx"].includes(ext)) return <span className="text-blue-600 font-bold text-xs bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">DOC</span>;
  if (["xls", "xlsx"].includes(ext)) return <span className="text-green-600 font-bold text-xs bg-green-50 border border-green-200 rounded px-1.5 py-0.5">XLS</span>;
  return <span className="text-slate-500 font-bold text-xs bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">FILE</span>;
}

interface ProgramItem {
  id: string; name: string; accountId: string;
  account: { id: string; name: string; cluster: { id: string; name: string } };
}
interface ClusterItem { id: string; name: string; type?: string }
interface AccountItem { id: string; name: string; cluster: { name: string } }
interface CascadeProgram { id: string; name: string }
interface PMUser { id: string; fullName: string; email: string }
interface ResolvedUser { id: string; fullName: string; email: string }
interface MyAssignments {
  role: string;
  programs: ProgramItem[];
  clients: ClusterItem[];
}

const emptyForm = {
  name: "", customer: "", accountId: "", programId: "", clusterId: "", pmOwnerId: "",
  engagementType: "application_development", projectType: "fixed_bid",
  methodology: "milestone_based", commercialModel: "fixed_price",
  sprintLengthWeeks: "2", engagementMode: "detailed", industry: "",
  budget: "", currency: "AUD", startDate: "", endDate: "", description: "",
};

// ── Processing overlay ────────────────────────────────────────────────────────

const STATUS_MSGS = [
  "Reading document…",
  "Extracting text content…",
  "Identifying requirements…",
  "Analysing scope & constraints…",
  "Building project context…",
];

const CHUNK_POSITIONS = [
  { tx: -90, ty: -55, rot: -18, delay: 0 },
  { tx: 10,  ty: -95, rot:   8, delay: 0.35 },
  { tx: 95,  ty: -50, rot:  22, delay: 0.6 },
  { tx: 100, ty:  40, rot: -12, delay: 0.2 },
  { tx: 5,   ty:  90, rot:  16, delay: 0.5 },
  { tx: -95, ty:  45, rot: -20, delay: 0.15 },
];

function ProcessingOverlay({ filename }: { filename: string }) {
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % STATUS_MSGS.length), 2800);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(15,23,42,0.75)", backdropFilter: "blur(6px)" }}>
      <style>{`
        @keyframes doc-breathe {
          0%,100% { transform: scale(1); filter: drop-shadow(0 0 0px #4f5bd5); }
          50% { transform: scale(1.06); filter: drop-shadow(0 0 12px #4f5bd580); }
        }
        @keyframes chunk-scatter {
          0%   { transform: translate(0,0) scale(0.15) rotate(0deg); opacity: 0; }
          15%  { opacity: 1; }
          100% { transform: translate(var(--tx),var(--ty)) scale(0.85) rotate(var(--rot)); opacity: 0; }
        }
        @keyframes progress-crawl {
          0%  { width: 4%; }
          15% { width: 30%; }
          40% { width: 55%; }
          70% { width: 74%; }
          90% { width: 88%; }
          99% { width: 95%; }
        }
        @keyframes status-fade {
          0%,100% { opacity: 1; }
          45%,55% { opacity: 0; }
        }
      `}</style>

      <div className="bg-white rounded-2xl shadow-2xl p-8 w-80 text-center">
        {/* animated area */}
        <div className="relative h-44 flex items-center justify-center mb-5">
          {/* flying chunks */}
          {CHUNK_POSITIONS.map((c, i) => (
            <div key={i} className="absolute" style={{
              top: "50%", left: "50%", marginTop: -12, marginLeft: -12,
              "--tx": `${c.tx}px`, "--ty": `${c.ty}px`, "--rot": `${c.rot}deg`,
              animation: `chunk-scatter 2.2s ease-out ${c.delay}s infinite`,
            } as React.CSSProperties}>
              <svg width="26" height="22" viewBox="0 0 26 22" fill="none">
                <rect x="1" y="1" width="24" height="20" rx="3" fill="#4f5bd5" opacity="0.85"/>
                <rect x="4" y="5"  width="14" height="2.5" rx="1.2" fill="white" opacity="0.65"/>
                <rect x="4" y="10" width="10" height="2.5" rx="1.2" fill="white" opacity="0.45"/>
                <rect x="4" y="15" width="7"  height="2"   rx="1"   fill="white" opacity="0.3"/>
              </svg>
            </div>
          ))}

          {/* main document */}
          <div style={{ animation: "doc-breathe 2s ease-in-out infinite", zIndex: 10 }}>
            <svg width="72" height="90" viewBox="0 0 72 90" fill="none">
              <rect x="2" y="2" width="68" height="86" rx="8" fill="#EEF0FC" stroke="#4f5bd5" strokeWidth="2.5"/>
              {/* dog-ear fold */}
              <path d="M52 2 L70 20 L52 20 Z" fill="#cfd4f5"/>
              <rect x="12" y="28" width="48" height="5" rx="2.5" fill="#4f5bd5" opacity="0.5"/>
              <rect x="12" y="38" width="40" height="5" rx="2.5" fill="#4f5bd5" opacity="0.38"/>
              <rect x="12" y="48" width="44" height="5" rx="2.5" fill="#4f5bd5" opacity="0.28"/>
              <rect x="12" y="58" width="30" height="5" rx="2.5" fill="#4f5bd5" opacity="0.18"/>
              <rect x="12" y="68" width="36" height="5" rx="2.5" fill="#4f5bd5" opacity="0.12"/>
            </svg>
          </div>
        </div>

        <p className="text-sm font-semibold text-slate-800 mb-1"
          style={{ animation: "status-fade 2.8s ease-in-out infinite", minHeight: 20 }}>
          {STATUS_MSGS[msgIdx]}
        </p>
        <p className="text-xs text-slate-400 mb-5 truncate px-2">{filename}</p>

        {/* progress bar */}
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-[#4f5bd5] to-[#7c3aed] rounded-full"
            style={{ animation: "progress-crawl 60s linear forwards" }} />
        </div>
        <p className="text-xs text-slate-300 mt-2">This may take up to a minute for large documents</p>
      </div>
    </div>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: number }) {
  const steps = ["Setup", "Upload", "Details"];
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((label, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        return (
          <div key={n} className="flex items-center">
            <div className="flex items-center gap-2">
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all",
                done  ? "bg-[#4f5bd5] text-white" :
                active ? "bg-[#4f5bd5] text-white ring-4 ring-[#cfd4f5]" :
                         "bg-slate-100 text-slate-400"
              )}>
                {done ? <CheckCircle2 className="w-4 h-4" /> : n}
              </div>
              <span className={cn("text-sm font-medium", active ? "text-[#4f5bd5]" : done ? "text-slate-600" : "text-slate-400")}>
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("h-px w-10 mx-3", step > n ? "bg-[#4f5bd5]" : "bg-slate-200")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<Mode>("upload");
  const [loading, setLoading] = useState(false);
  const [nlText, setNlText] = useState("");
  const [form, setForm] = useState(emptyForm);

  const [myAssignments, setMyAssignments] = useState<MyAssignments | null>(null);
  const [allClusters, setAllClusters] = useState<ClusterItem[]>([]);
  const [dhAccounts, setDhAccounts] = useState<AccountItem[]>([]);
  const [dhPrograms, setDhPrograms] = useState<CascadeProgram[]>([]);
  const [availablePMs, setAvailablePMs] = useState<PMUser[]>([]);
  const [resolvedDh, setResolvedDh] = useState<ResolvedUser | null>(null);
  const [resolvedDm, setResolvedDm] = useState<ResolvedUser | null>(null);
  const [dhAlert, setDhAlert] = useState<string | null>(null);
  const [dmAlert, setDmAlert] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<UploadedDoc[]>([]);

  const role = myAssignments?.role;
  const blocked = !!(dhAlert || dmAlert);
  const isProcessing = docs.some((d) => d.status === "parsing");
  const hasSuccess = docs.some((d) => d.status === "done");

  // Skip hierarchy step for admin (no selects needed)
  useEffect(() => {
    if (myAssignments?.role === "admin" && step === 1) setStep(2);
  }, [myAssignments?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/me/assignments")
      .then((r) => r.json())
      .then((data: MyAssignments) => {
        setMyAssignments(data);
        if (data.role === "pm") {
          fetch("/api/clusters/active")
            .then((r) => r.json())
            .then((d) => setAllClusters(Array.isArray(d) ? d : []))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.clusterId || !["pm", "dh"].includes(myAssignments?.role ?? "")) return;
    setDhAccounts([]); setDhPrograms([]);
    setForm((f) => ({ ...f, accountId: "", programId: "", customer: "" }));
    setResolvedDh(null); setResolvedDm(null); setDhAlert(null); setDmAlert(null);
    fetch(`/api/accounts?clusterId=${form.clusterId}`)
      .then((r) => r.json())
      .then((d) => setDhAccounts(Array.isArray(d) ? d : []))
      .catch(() => {});
    resolveDH(form.clusterId);
  }, [form.clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.accountId || !["pm", "dh"].includes(myAssignments?.role ?? "")) return;
    setDhPrograms([]); setForm((f) => ({ ...f, programId: "" }));
    setResolvedDm(null); setDmAlert(null);
    const acc = dhAccounts.find((a) => a.id === form.accountId);
    if (acc) setForm((f) => ({ ...f, customer: acc.name }));
    fetch(`/api/accounts/${form.accountId}/programs`)
      .then((r) => r.json())
      .then((d) => setDhPrograms(Array.isArray(d) ? d : []))
      .catch(() => {});
    resolveDM(form.accountId);
  }, [form.accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.programId || myAssignments?.role !== "pgm") return;
    const prog = myAssignments.programs.find((p) => p.id === form.programId);
    if (!prog) return;
    setForm((f) => ({ ...f, accountId: prog.accountId, clusterId: prog.account.cluster.id, customer: prog.account.name }));
    resolveHierarchy(prog.account.cluster.id, prog.accountId);
    fetch(`/api/users/pms?programId=${form.programId}`)
      .then((r) => r.json())
      .then((d) => setAvailablePMs(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [form.programId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveDH(clusterId: string) {
    setResolving(true); setDhAlert(null); setResolvedDh(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/primary-dh`);
      const data = await res.json();
      if (res.status === 422) setDhAlert(data.error?.message || "No Primary DH assigned.");
      else if (res.ok) setResolvedDh(data.dh);
    } catch { setDhAlert("Could not verify Primary Delivery Head."); }
    finally { setResolving(false); }
  }

  async function resolveDM(accountId: string) {
    setResolving(true); setDmAlert(null); setResolvedDm(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/primary-dm`);
      const data = await res.json();
      if (res.status === 422) setDmAlert(data.error?.message || "No Primary DM assigned.");
      else if (res.ok) setResolvedDm(data.dm);
    } catch { setDmAlert("Could not verify Primary Delivery Manager."); }
    finally { setResolving(false); }
  }

  async function resolveHierarchy(clusterId: string, accountId: string) {
    await Promise.all([resolveDH(clusterId), resolveDM(accountId)]);
  }

  function update(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleFilePick(file: File) {
    if (docs.some((d) => d.file.name === file.name && d.file.size === file.size)) {
      toast({ title: "Already added", description: file.name }); return;
    }
    const docId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setDocs((prev) => [...prev, { docId, file, status: "parsing", summary: [] }]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/parse-requirements", { method: "POST", body: fd });
      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new Error(
          res.status === 504
            ? "The file took too long to process. Try a smaller document or wait and retry."
            : `Server error (${res.status}): the request failed. Try again or use a smaller file.`
        );
      }
      if (!res.ok) throw new Error(data.error?.message || "Failed to parse file");
      const pf = data.projectFields as Record<string, unknown>;
      setForm((f) => ({
        ...f,
        name: f.name || (pf.name as string) || "",
        customer: myAssignments?.role === "pm" ? f.customer : f.customer || (pf.customer as string) || "",
        projectType: f.projectType || (pf.projectType as string) || "fixed_bid",
        methodology: f.methodology || (pf.methodology as string) || "milestone_based",
        industry: f.industry || (pf.industry as string) || "",
        budget: f.budget || (pf.budget ? String(pf.budget) : ""),
        currency: pf.currency ? (pf.currency as string) : f.currency,
        startDate: f.startDate || (pf.startDate ? String(pf.startDate).slice(0, 10) : ""),
        endDate: f.endDate || (pf.endDate ? String(pf.endDate).slice(0, 10) : ""),
        description: f.description || (pf.description as string) || "",
      }));
      const req = data.requirements as Record<string, unknown>;
      const sowAssumptions: string[] = Array.isArray(req.assumptions) ? (req.assumptions as string[]) : [];
      const sowDependencies: { description: string; type: string; owner?: string }[] =
        Array.isArray(req.dependencies) ? (req.dependencies as any[]) : [];
      const bullets: string[] = [`From: ${file.name}`];
      if (Array.isArray(req.goals) && req.goals.length) bullets.push(`${req.goals.length} goal(s) identified`);
      if (Array.isArray(req.stakeholders) && req.stakeholders.length) bullets.push(`${req.stakeholders.length} stakeholder(s) found`);
      if (Array.isArray(req.constraints) && req.constraints.length) bullets.push(`${req.constraints.length} constraint(s) detected`);
      if (Array.isArray(req.scopeItems) && req.scopeItems.length) bullets.push(`${req.scopeItems.length} scope item(s) extracted`);
      if (sowAssumptions.length) bullets.push(`${sowAssumptions.length} assumption(s) extracted`);
      if (sowDependencies.length) bullets.push(`${sowDependencies.length} dependenc${sowDependencies.length === 1 ? "y" : "ies"} extracted`);
      if (req.timeline) bullets.push(`Timeline: ${req.timeline}`);
      if (bullets.length === 1) bullets.push("Requirements extracted successfully");
      setDocs((prev) =>
        prev.map((d) =>
          d.docId === docId ? { ...d, status: "done", summary: bullets, parsed: {
            requirementsText: data.extractedText, requirementsFileName: data.fileName,
            requirementsFileFormat: data.fileFormat, requirementsExtracted: req,
            sowAssumptions, sowDependencies,
          } } : d
        )
      );
    } catch (err: any) {
      toast({ title: "Parse failed", description: err.message, variant: "destructive" });
      setDocs((prev) => prev.map((d) => (d.docId === docId ? { ...d, status: "error", errorMsg: err.message } : d)));
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach((f) => handleFilePick(f));
  }

  function removeDoc(docId: string) { setDocs((prev) => prev.filter((d) => d.docId !== docId)); }

  async function handleSubmit() {
    if (blocked) {
      toast({ title: "Cannot create project", description: "Resolve DH/DM issues first.", variant: "destructive" });
      return;
    }
    setLoading(true);
    let payload: Record<string, unknown>;
    if (mode === "nl") {
      payload = {
        naturalLanguage: nlText, engagementMode: "detailed",
        ...(form.accountId ? { accountId: form.accountId } : {}),
        ...(form.programId ? { programId: form.programId } : {}),
        ...(form.pmOwnerId ? { pmOwnerId: form.pmOwnerId } : {}),
      };
    } else {
      const { accountId, programId, pmOwnerId, clusterId, sprintLengthWeeks, ...rest } = form;
      const isAgile = form.methodology === "agile_scrum";
      payload = {
        ...rest, engagementMode: "detailed",
        budget: form.budget ? parseFloat(form.budget) : undefined,
        deliveryMethod: isAgile ? "agile_scrum" : "predictive",
        commercialModel: isAgile ? form.commercialModel : (form.projectType === "time_and_material" ? "time_and_materials" : "fixed_price"),
        ...(isAgile && sprintLengthWeeks ? { sprintLengthWeeks: parseInt(sprintLengthWeeks) } : {}),
        ...(clusterId ? { clusterId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(programId ? { programId } : {}),
        ...(pmOwnerId ? { pmOwnerId } : {}),
      };
      const doneDocs = docs.filter((d) => d.status === "done" && d.parsed);
      if (doneDocs.length > 0) {
        payload.requirementsText = doneDocs.map((d) => d.parsed!.requirementsText).join("\n\n---\n\n");
        payload.requirementsFileName = doneDocs.map((d) => d.parsed!.requirementsFileName).join(", ");
        payload.requirementsFileFormat = doneDocs[0].parsed!.requirementsFileFormat;
        payload.requirementsExtracted = doneDocs.reduce((acc, d) => ({ ...acc, ...d.parsed!.requirementsExtracted }), {});
        const allAssumptions = doneDocs.flatMap((d) => d.parsed!.sowAssumptions ?? []);
        const allDependencies = doneDocs.flatMap((d) => d.parsed!.sowDependencies ?? []);
        if (allAssumptions.length > 0) payload.sowAssumptions = allAssumptions;
        if (allDependencies.length > 0) payload.sowDependencies = allDependencies;
      }
    }
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message);
      toast({ title: "Project created!", description: data.name });
      router.push(`/dashboard/projects/${data.id}`);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setLoading(false);
    }
  }

  // Step 1 validity: role has made required hierarchy selections
  const step1Valid = !role || role === "admin" || (
    !blocked &&
    (role === "pgm" ? !!form.programId : (!!form.clusterId && !!form.accountId))
  );

  // Derived: the doc currently being processed (for overlay filename)
  const processingDoc = docs.find((d) => d.status === "parsing");

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Processing overlay */}
      {isProcessing && processingDoc && (
        <ProcessingOverlay filename={processingDoc.file.name} />
      )}

      <div className="p-8 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard/projects">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">New Project</h1>
            <p className="text-slate-500 text-sm">Set up your project workspace in 3 steps</p>
          </div>
        </div>

        <StepIndicator step={step} />

        {/* ── Step 1: Hierarchy ───────────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Where does this project belong?</CardTitle>
                <CardDescription>
                  {role === "pgm"
                    ? "Select the program this project will be created under."
                    : "Select the cluster and account. Program is optional."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Alert banners */}
                {(dhAlert || dmAlert) && (
                  <div className="space-y-2">
                    {dhAlert && (
                      <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-3">
                        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-semibold text-red-800">No Primary Delivery Head</p>
                          <p className="text-sm text-red-700 mt-0.5">{dhAlert}</p>
                        </div>
                      </div>
                    )}
                    {dmAlert && (
                      <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-3">
                        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-semibold text-red-800">No Primary Delivery Manager</p>
                          <p className="text-sm text-red-700 mt-0.5">{dmAlert}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Resolved DH/DM chips */}
                {(resolvedDh || resolvedDm) && (
                  <div className="flex flex-wrap gap-2">
                    {resolvedDh && (
                      <span className="flex items-center gap-1.5 text-xs bg-[#E1F5EE] border border-[#9FE1CB] text-[#0F6E56] px-3 py-1.5 rounded-full font-medium">
                        <User className="w-3 h-3" /> DH: {resolvedDh.fullName}
                      </span>
                    )}
                    {resolvedDm && (
                      <span className="flex items-center gap-1.5 text-xs bg-[#E1F5EE] border border-[#9FE1CB] text-[#0F6E56] px-3 py-1.5 rounded-full font-medium">
                        <User className="w-3 h-3" /> DM: {resolvedDm.fullName}
                      </span>
                    )}
                  </div>
                )}

                {/* PM cascade */}
                {role === "pm" && (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label>Cluster <span className="text-red-400">*</span></Label>
                      <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                        value={form.clusterId} onChange={(e) => update("clusterId", e.target.value)}>
                        <option value="">Select cluster…</option>
                        {allClusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    {form.clusterId && dhAccounts.length > 0 && (
                      <div className="space-y-1.5">
                        <Label>Account <span className="text-red-400">*</span></Label>
                        <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                          value={form.accountId} onChange={(e) => update("accountId", e.target.value)}>
                          <option value="">Select account…</option>
                          {dhAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </div>
                    )}
                    {form.clusterId && dhAccounts.length === 0 && (
                      <p className="text-xs text-amber-600">No active accounts in this cluster.</p>
                    )}
                    {form.accountId && (
                      <div className="space-y-1.5">
                        <Label>Program <span className="text-slate-400 font-normal">(optional)</span></Label>
                        <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                          value={form.programId} onChange={(e) => update("programId", e.target.value)}>
                          <option value="">No program (direct account project)</option>
                          {dhPrograms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {/* PGM cascade */}
                {role === "pgm" && (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label>Program <span className="text-red-400">*</span></Label>
                      <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                        value={form.programId} onChange={(e) => update("programId", e.target.value)}>
                        <option value="">Select program…</option>
                        {myAssignments?.programs.map((p) => (
                          <option key={p.id} value={p.id}>{p.account.cluster.name} › {p.account.name} › {p.name}</option>
                        ))}
                      </select>
                    </div>
                    {form.programId && (
                      <div className="space-y-1.5">
                        <Label>Assign PM <span className="text-slate-400 font-normal">(optional)</span></Label>
                        <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                          value={form.pmOwnerId} onChange={(e) => update("pmOwnerId", e.target.value)}>
                          <option value="">Assign to me (acting PM)</option>
                          {availablePMs.map((pm) => <option key={pm.id} value={pm.id}>{pm.fullName} ({pm.email})</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {/* DH cascade */}
                {role === "dh" && (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label>Cluster <span className="text-red-400">*</span></Label>
                      <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                        value={form.clusterId} onChange={(e) => update("clusterId", e.target.value)}>
                        <option value="">Select cluster…</option>
                        {myAssignments?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    {form.clusterId && dhAccounts.length > 0 && (
                      <div className="space-y-1.5">
                        <Label>Account <span className="text-red-400">*</span></Label>
                        <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                          value={form.accountId} onChange={(e) => update("accountId", e.target.value)}>
                          <option value="">Select account…</option>
                          {dhAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </div>
                    )}
                    {form.clusterId && dhAccounts.length === 0 && (
                      <p className="text-xs text-amber-600">No active accounts in this cluster.</p>
                    )}
                    {form.accountId && (
                      <>
                        <div className="space-y-1.5">
                          <Label>Program <span className="text-slate-400 font-normal">(optional)</span></Label>
                          <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                            value={form.programId} onChange={(e) => update("programId", e.target.value)}>
                            <option value="">No program (direct account project)</option>
                            {dhPrograms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Assign PM <span className="text-slate-400 font-normal">(optional)</span></Label>
                          <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4f5bd5]"
                            value={form.pmOwnerId} onChange={(e) => update("pmOwnerId", e.target.value)}>
                            <option value="">No PM assigned yet</option>
                            {availablePMs.map((pm) => <option key={pm.id} value={pm.id}>{pm.fullName} ({pm.email})</option>)}
                          </select>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {resolving && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="w-3 h-3 animate-spin" /> Verifying DH &amp; DM assignments…
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={() => setStep(2)} disabled={!step1Valid || resolving}
                className="gap-2 px-6">
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Upload ──────────────────────────────────────────── */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Mode toggle */}
            <div className="flex gap-2">
              {([
                { id: "upload" as const, icon: Upload, label: "Upload Document" },
                { id: "nl" as const, icon: Wand2, label: "Use AI" },
              ]).map(({ id, icon: Icon, label }) => (
                <button key={id} onClick={() => setMode(id)}
                  className={cn("flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all",
                    mode === id ? "bg-[#4f5bd5] text-white border-[#4f5bd5]" : "bg-white text-slate-600 border-slate-200 hover:border-[#cfd4f5]")}>
                  <Icon className="w-4 h-4" />{label}
                </button>
              ))}
            </div>

            {mode === "upload" && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Upload your BRD or SOW</CardTitle>
                  <CardDescription>AI will extract project fields and requirements automatically. Supports PDF, Word, and text files.</CardDescription>
                </CardHeader>
                <div className="mx-6 mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex gap-3 items-start">
                  <span className="text-amber-500 text-base mt-0.5">💡</span>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    <span className="font-semibold">Why this matters — </span>
                    Every artifact the agent generates draws context from this document. The more complete your BRD or SOW, the more accurate your artifacts will be.
                  </p>
                </div>
                <CardContent className="space-y-4">
                  {/* Drop zone — only show if no successful doc yet */}
                  {!hasSuccess && (
                    <div
                      onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
                      onClick={() => fileRef.current?.click()}
                      className="border-2 border-dashed border-slate-300 rounded-xl p-10 text-center cursor-pointer hover:border-[#4f5bd5] hover:bg-[#eef0fc] transition-all"
                    >
                      <FileText className="w-10 h-10 text-[#4f5bd5] mx-auto mb-3 opacity-70" />
                      <p className="text-sm font-semibold text-slate-700">Drop your document here or click to browse</p>
                      <p className="text-xs text-slate-400 mt-1">PDF · DOCX · XLSX · TXT · MD</p>
                      <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md" className="hidden"
                        onChange={(e) => { Array.from(e.target.files ?? []).forEach(handleFilePick); e.target.value = ""; }} />
                    </div>
                  )}

                  {/* Doc status cards */}
                  {docs.length > 0 && (
                    <div className="space-y-2">
                      {docs.map((doc) => (
                        <div key={doc.docId} className="rounded-lg border border-slate-200 overflow-hidden">
                          <div className="flex items-center gap-3 px-3 py-2.5 bg-slate-50">
                            {fileIcon(doc.file.name)}
                            <span className="text-sm font-medium text-slate-800 flex-1 truncate">{doc.file.name}</span>
                            {doc.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
                            {doc.status === "error" && <span className="text-xs text-red-500 shrink-0">Failed</span>}
                            {doc.status !== "parsing" && (
                              <button type="button" onClick={() => removeDoc(doc.docId)} className="text-slate-400 hover:text-slate-700 shrink-0"><X className="w-4 h-4" /></button>
                            )}
                          </div>
                          {doc.status === "done" && doc.summary.length > 0 && (
                            <div className="px-3 py-2.5 bg-green-50 space-y-0.5">
                              {doc.summary.map((b, j) => (
                                <p key={j} className={cn("text-xs flex items-start gap-1.5", j === 0 ? "font-semibold text-green-800" : "text-green-700")}>
                                  {j > 0 && <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" />}{b}
                                </p>
                              ))}
                            </div>
                          )}
                          {doc.status === "error" && (
                            <div className="px-3 py-2 bg-red-50 text-xs text-red-600">
                              {doc.errorMsg || "Could not extract content from this file."}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Replace / retry if failed — reuse existing fileRef input in the drop zone */}
                  {docs.some((d) => d.status === "error") && !hasSuccess && (
                    <button type="button"
                      onClick={() => { setDocs([]); fileRef.current?.click(); }}
                      className="text-xs text-[#4f5bd5] underline underline-offset-2">
                      Try a different file
                    </button>
                  )}
                </CardContent>
              </Card>
            )}

            {mode === "nl" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Describe your project</CardTitle>
                  <CardDescription>Write naturally — AI will infer structured fields and generate your artifact workspace.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Textarea
                    placeholder='e.g. "Build an ERP implementation for a retail company, 12 months, $2M budget. Milestone-based delivery."'
                    value={nlText} onChange={(e) => setNlText(e.target.value)} rows={6} />
                </CardContent>
              </Card>
            )}

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)} className="gap-2">
                <ArrowLeft className="w-4 h-4" /> Back
              </Button>
              <Button
                onClick={() => setStep(3)}
                disabled={mode === "upload" ? !hasSuccess : nlText.trim().length < 20}
                className="gap-2 px-6"
              >
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Project details ─────────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-4">
            <ProjectFormFields form={form} update={update} role={role} />

            {blocked && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Project creation is blocked — resolve DH/DM assignment issues in Step 1 first.
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)} className="gap-2">
                <ArrowLeft className="w-4 h-4" /> Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading || blocked || !form.name.trim()}
                size="lg"
                className="gap-2 px-8"
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating project…</>
                  : <><CheckCircle2 className="w-4 h-4" /> Create Project</>}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Project form fields ───────────────────────────────────────────────────────

function ProjectFormFields({ form, update, role }: { form: typeof emptyForm; update: (f: string, v: string) => void; role?: string }) {
  const isAgile = form.methodology === "agile_scrum";
  return (
    <>
      <Card>
        <CardHeader><CardTitle className="text-base">Project Details</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-2">
            <Label>Project Name <span className="text-red-400">*</span></Label>
            <Input placeholder="ERP Implementation — Retail" value={form.name} onChange={(e) => update("name", e.target.value)} required />
          </div>
          {(!role || role === "admin" || role === "pgm" || role === "dh") && (
            <div className="space-y-2">
              <Label>Customer / Account</Label>
              <Input placeholder="Acme Retail" value={form.customer} onChange={(e) => update("customer", e.target.value)}
                readOnly={role === "pgm" || role === "dh"} className={role === "pgm" || role === "dh" ? "bg-slate-50 text-slate-600" : ""} />
            </div>
          )}
          <div className="space-y-2">
            <Label>Industry</Label>
            <Input placeholder="Retail, Financial Services…" value={form.industry} onChange={(e) => update("industry", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Engagement Type</Label>
            <Select value={form.engagementType} onValueChange={(v) => update("engagementType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="application_development">Application Development</SelectItem>
                <SelectItem value="product_development">Product Development</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Methodology</Label>
            <Select value={form.methodology} onValueChange={(v) => update("methodology", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="milestone_based">Waterfall</SelectItem>
                <SelectItem value="agile_scrum">Agile (Scrum)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isAgile && (
            <div className="space-y-2">
              <Label>Billing Type</Label>
              <Select value={form.projectType} onValueChange={(v) => update("projectType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed_bid">Fixed Bid (Milestone Based)</SelectItem>
                  <SelectItem value="time_and_material">Time and Material</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {isAgile && (
            <div className="col-span-2 rounded-lg border border-[#cfd4f5] bg-[#f5f6fd] px-4 py-3 mt-1">
              <p className="text-xs font-semibold text-[#4f5bd5] mb-3 uppercase tracking-wide">Agile Scrum Configuration</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Commercial Model</Label>
                  <Select value={form.commercialModel} onValueChange={(v) => update("commercialModel", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed_price">Fixed Price</SelectItem>
                      <SelectItem value="time_and_materials">Time &amp; Materials</SelectItem>
                      <SelectItem value="capped_tm">Capped T&amp;M</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Sprint Length (weeks)</Label>
                  <Select value={form.sprintLengthWeeks} onValueChange={(v) => update("sprintLengthWeeks", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 week</SelectItem>
                      <SelectItem value="2">2 weeks</SelectItem>
                      <SelectItem value="3">3 weeks</SelectItem>
                      <SelectItem value="4">4 weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Timeline &amp; Budget</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Start Date</Label>
            <Input type="date" value={form.startDate} onChange={(e) => update("startDate", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>End Date</Label>
            <Input type="date" value={form.endDate} onChange={(e) => update("endDate", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Budget</Label>
            <Input type="number" placeholder="1000000" value={form.budget} onChange={(e) => update("budget", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Currency</Label>
            <Select value={form.currency} onValueChange={(v) => update("currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="AUD">AUD</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="GBP">GBP</SelectItem>
                <SelectItem value="INR">INR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-2">
            <Label>Description</Label>
            <Textarea placeholder="Brief project description…" value={form.description} onChange={(e) => update("description", e.target.value)} rows={3} />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

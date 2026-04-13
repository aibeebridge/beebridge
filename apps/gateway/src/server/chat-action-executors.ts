/**
 * Server-side executors for `/api/chat` action tools.
 * State is injected via ChatActionDeps to keep index.ts thinner and allow testing.
 */

import { randomUUID } from "node:crypto";
import {
  newBeeId,
  type ApprovalGate,
  type AuditLog,
  type BeeDistrict,
  type BeePersona,
  type BeeTask,
  type BridgeGraphMeta,
  type DistrictBridge,
  type FlowerType,
  type PmRuntimeContext,
  type TaskSchedule,
  type TeamPlan,
  type WaggleConfig,
} from "@beebridge/core";
import type { BeePriority } from "@beebridge/shared";
import type {
  ApprovePendingTasksArgs,
  RunTasksArgs,
  SetupPlanArgs,
  UpdateDistrictSettingsArgs,
  CreateBridgeArgs,
  SetBridgeStartArgs,
} from "./chat-tools.js";

const VALID_BEE_ROLES = new Set(["researcher", "analyst", "writer", "coder", "reviewer"]);

export type ChatActionDeps = {
  resolveRuntimeContext: () => PmRuntimeContext;
  getLatestTeamPlan: () => TeamPlan | null;
  setLatestTeamPlan: (p: TeamPlan | null) => void;
  getBridgeGraphMeta: () => BridgeGraphMeta;
  setBridgeGraphMeta: (m: BridgeGraphMeta) => void;
  allDistricts: Map<string, BeeDistrict>;
  allTasks: Map<string, BeeTask>;
  districtBridges: Map<string, DistrictBridge>;
  taskSchedules: Map<string, TaskSchedule>;
  approvalGate: ApprovalGate;
  syncGraph: () => void;
  persistWorkspace: () => void;
  broadcastToWeb: (msg: Record<string, unknown>) => void;
  auditLog: AuditLog;
  log: (tag: string, detail: string) => void;
  /** When set, runs tasks that skip human approval right after `setup_plan` (gateway schedules queue). */
  runAutoApprovedChatTasks?: (tasks: BeeTask[]) => void;
};

function pickFlowerForBee(
  runtime: PmRuntimeContext,
  role: string,
  needsCode?: boolean,
): { flowerType: FlowerType; flower: string } {
  const useCode = role === "coder" || needsCode === true;
  if (useCode) {
    return { flowerType: "code", flower: `${runtime.providerId}-code` };
  }
  return { flowerType: "browser", flower: `${runtime.providerId}-browser` };
}

export function execSetupPlan(args: SetupPlanArgs, d: ChatActionDeps): string {
  if (!args.bees?.length) {
    return "Error: bees array must be non-empty.";
  }
  for (const b of args.bees) {
    const role = String(b.role ?? "").trim();
    if (!VALID_BEE_ROLES.has(role)) {
      return `Error: invalid bee role "${b.role}". Use one of: researcher, analyst, writer, coder, reviewer.`;
    }
    const bn = String(b.name ?? "").trim();
    const mission = String(b.mission ?? "").trim();
    if (!bn) {
      return "Error: every bee must have a non-empty name.";
    }
    if (!mission) {
      return `Error: bee "${bn}" must have a non-empty mission (persona / concrete work to do, e.g. what to build).`;
    }
  }

  const runtime = d.resolveRuntimeContext();
  const latestTeamPlan = d.getLatestTeamPlan();
  const cityId = latestTeamPlan?.id ?? `city-${Date.now()}`;
  const priority = (args.priority ?? "medium") as BeePriority;

  const anyNeedsWaggle = args.bees.some((b) => b.needsWaggle === true);
  const waggleMode = args.waggleMode ?? (anyNeedsWaggle ? "browser" : "off");
  const allowBrowserFirst = args.allowBrowserBeforeFirstWaggle !== false;
  const waggle: WaggleConfig = {
    enabled: waggleMode !== "off",
    mode: waggleMode,
    autoDetect: true,
    allowBrowserBeforeFirstWaggle: allowBrowserFirst,
  };

  const responseLocale =
    typeof args.responseLocale === "string" && args.responseLocale.trim()
      ? args.responseLocale.trim()
      : "en";

  function appendOutputLocale(mission: string): string {
    return `${mission}\n\nUser-facing output language (responseLocale): ${responseLocale}. The final done() summary and all user-visible output MUST use this language.`;
  }

  let district: BeeDistrict;
  let explicitTarget = args.targetDistrictId && d.allDistricts.has(args.targetDistrictId);

  if (!explicitTarget) {
    const normTitle = args.title.trim().toLowerCase();
    for (const existing of d.allDistricts.values()) {
      if (existing.title.trim().toLowerCase() === normTitle && existing.status === "active") {
        explicitTarget = true;
        args = { ...args, targetDistrictId: existing.id };
        d.log("CHAT_ACTION", `auto-matched existing district "${existing.title}" (${existing.id}) for title "${args.title}"`);
        break;
      }
    }
  }

  const isNewDistrict = !explicitTarget;

  if (!isNewDistrict) {
    district = d.allDistricts.get(args.targetDistrictId!)!;
    const prevWaggle = district.waggle;
    district.waggle = {
      ...(prevWaggle ?? { enabled: false, mode: "off" as const, autoDetect: true }),
      ...waggle,
      browserTargetUrl: prevWaggle?.browserTargetUrl ?? waggle.browserTargetUrl,
      browserInputSelector: prevWaggle?.browserInputSelector ?? waggle.browserInputSelector,
      apiProviderId: prevWaggle?.apiProviderId ?? waggle.apiProviderId,
      apiModel: prevWaggle?.apiModel ?? waggle.apiModel,
      apiKey: prevWaggle?.apiKey ?? waggle.apiKey,
    };
  } else {
    const id = `district-${randomUUID().slice(0, 8)}`;
    district = {
      id,
      cityId,
      status: "active",
      title: args.title,
      objective: args.objective ?? "",
      waggle,
    };
    d.allDistricts.set(id, district);
  }

  const createdBees: BeePersona[] = [];
  const createdTasks: BeeTask[] = [];
  let prevTaskId: string | undefined;

  for (let seq = 0; seq < args.bees.length; seq++) {
    const spec = args.bees[seq]!;
    const beeId = newBeeId();
    const role = String(spec.role ?? "researcher").trim();
    const { flowerType, flower } = pickFlowerForBee(runtime, role, spec.needsCode);

    const missionLocalized = appendOutputLocale(spec.mission);
    const bee: BeePersona = {
      id: beeId,
      name: spec.name,
      role,
      systemPrompt: missionLocalized,
      providerId: runtime.providerId,
      model: runtime.model,
      flowerType,
    };
    createdBees.push(bee);

    let suffix = randomUUID().slice(0, 8);
    let taskId = `task-${String(seq).padStart(6, "0")}-${suffix}`;
    while (d.allTasks.has(taskId) || d.approvalGate.isTracked(taskId)) {
      suffix = randomUUID().slice(0, 8);
      taskId = `task-${String(seq).padStart(6, "0")}-${suffix}`;
    }

    let description = missionLocalized;
    if (prevTaskId) {
      description = `${missionLocalized}\n\nPrior task output (resolved at run time): {{bridgeOut:${prevTaskId}}}`;
    }

    const task: BeeTask = {
      id: taskId,
      title: `${args.title} — ${spec.name}`,
      description,
      districtId: district.id,
      cityId: district.cityId,
      bee: beeId,
      flower,
      assignee: beeId,
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      priority,
      requiresApproval: args.requiresApproval === true,
      status: "waiting",
      personaId: beeId,
      responseLocale,
    };
    createdTasks.push(task);
    d.allTasks.set(taskId, task);
    prevTaskId = taskId;

    const sched: TaskSchedule = { repeatType: "once", maxRetries: 3, retryCount: 0, enabled: true };
    d.taskSchedules.set(taskId, sched);
    task.schedule = sched;

    if (d.approvalGate.needsApproval(task)) {
      d.approvalGate.register(task);
    } else {
      d.approvalGate.seedAutoApproved(task);
    }
  }

  const hasDependsOnBees = args.bees.some((b) => b.dependsOnBees && b.dependsOnBees.length > 0);
  if (hasDependsOnBees) {
    for (let i = 0; i < args.bees.length; i++) {
      const spec = args.bees[i]!;
      const task = createdTasks[i]!;
      if (spec.dependsOnBees && spec.dependsOnBees.length > 0) {
        task.dependsOn = spec.dependsOnBees
          .filter((idx) => idx >= 0 && idx < createdTasks.length && idx !== i)
          .map((idx) => createdTasks[idx]!.id);
      }
    }
  }

  district.beeRosterIds = [...(district.beeRosterIds ?? []), ...createdBees.map((b) => b.id)];

  const beeById = new Map((latestTeamPlan?.bees ?? []).map((b) => [b.id, b]));
  for (const bee of createdBees) beeById.set(bee.id, bee);
  d.setLatestTeamPlan({
    id: latestTeamPlan?.id ?? cityId,
    goal: latestTeamPlan?.goal ?? args.title,
    bees: [...beeById.values()],
    districts: [...d.allDistricts.values()],
    tasks: [...d.allTasks.values()],
  });

  d.syncGraph();
  d.persistWorkspace();
  d.broadcastToWeb({ type: "districts.updated" });
  d.broadcastToWeb({ type: "jobs.updated" });
  d.auditLog.record({
    type: "city.plan.created",
    payload: {
      goal: args.title,
      taskCount: createdTasks.length,
      districtCount: 1,
      beeCount: createdBees.length,
      provider: runtime.providerId,
      model: runtime.model,
      source: "chat",
    },
  });

  const autoRunTasks = createdTasks.filter((t) => !d.approvalGate.needsApproval(t));
  if (autoRunTasks.length > 0 && d.runAutoApprovedChatTasks) {
    d.runAutoApprovedChatTasks(autoRunTasks);
  }

  const lines: string[] = [];
  lines.push(`District "${district.title}" (${district.id}) — ${isNewDistrict ? "created" : "updated"}`);
  lines.push(`Waggle: mode=${waggle.mode}, enabled=${waggle.enabled}`);
  for (const bee of createdBees) {
    const task = createdTasks.find((t) => t.personaId === bee.id);
    lines.push(`Bee "${bee.name}" (${bee.id}) role=${bee.role} flower=${bee.flowerType} — Task ${task?.id ?? "?"} [${priority}]`);
  }
  if (autoRunTasks.length > 0) {
    lines.push(
      `Execution started for ${autoRunTasks.length} task(s) that do not require approval (chat). Check the Jobs page for live logs.`,
    );
  }
  lines.push(`Pending approvals: ${d.approvalGate.listPending().length}`);
  d.log("CHAT_ACTION", `setup_plan: ${createdBees.length} bees, ${createdTasks.length} tasks in district ${district.id}`);
  return lines.join("\n");
}

export function execUpdateDistrictSettings(args: UpdateDistrictSettingsArgs, d: ChatActionDeps): string {
  const district = d.allDistricts.get(args.districtId);
  if (!district) return `Error: district ${args.districtId} not found`;

  if (args.objective !== undefined) district.objective = args.objective;
  if (args.useUpstreamBridgeContext !== undefined) district.useUpstreamBridgeContext = args.useUpstreamBridgeContext;

  if (
    args.waggleMode !== undefined ||
    args.waggleEnabled !== undefined ||
    args.waggleAutoDetect !== undefined ||
    args.allowBrowserBeforeFirstWaggle !== undefined
  ) {
    const prev = district.waggle ?? { enabled: false, mode: "off" as const, autoDetect: true };
    district.waggle = {
      ...prev,
      enabled: args.waggleEnabled ?? prev.enabled,
      mode: args.waggleMode ?? prev.mode,
      autoDetect: args.waggleAutoDetect ?? prev.autoDetect,
      allowBrowserBeforeFirstWaggle:
        args.allowBrowserBeforeFirstWaggle ?? prev.allowBrowserBeforeFirstWaggle,
    };
  }

  d.syncGraph();
  d.persistWorkspace();
  d.broadcastToWeb({ type: "districts.updated" });
  d.log("CHAT_ACTION", `update_district_settings: ${district.id} "${district.title}"`);
  return `District "${district.title}" (${district.id}) updated. Waggle: ${JSON.stringify(district.waggle)}`;
}

export function execCreateBridge(args: CreateBridgeArgs, d: ChatActionDeps): string {
  if (!d.allDistricts.has(args.fromDistrictId)) return `Error: source district ${args.fromDistrictId} not found`;
  if (!d.allDistricts.has(args.toDistrictId)) return `Error: target district ${args.toDistrictId} not found`;

  const id = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bridge: DistrictBridge = {
    id,
    fromDistrictId: args.fromDistrictId,
    toDistrictId: args.toDistrictId,
    label: args.label,
    direction: args.direction === "two_way" ? "two_way" : "one_way",
    status: "active",
    createdAt: new Date().toISOString(),
  };
  d.districtBridges.set(id, bridge);
  d.syncGraph();
  d.persistWorkspace();
  d.broadcastToWeb({ type: "bridges.updated" });
  d.auditLog.record({
    type: "bridge.created",
    payload: { id, fromDistrictId: args.fromDistrictId, toDistrictId: args.toDistrictId, label: args.label },
  });
  d.log("CHAT_ACTION", `create_bridge: ${id} (${args.fromDistrictId} → ${args.toDistrictId})`);
  return `Bridge "${args.label}" (${id}) created: ${args.fromDistrictId} → ${args.toDistrictId} [${bridge.direction}]`;
}

export function execSetBridgeStart(args: SetBridgeStartArgs, d: ChatActionDeps): string {
  if (args.clear === true) {
    d.setBridgeGraphMeta({ startDistrictId: null });
    d.persistWorkspace();
    d.broadcastToWeb({ type: "bridges.updated" });
    d.log("CHAT_ACTION", "set_bridge_start: cleared");
    return "Bridge pipeline start cleared.";
  }
  const did = args.districtId?.trim();
  if (!did) {
    return "Error: provide districtId to set the pipeline start, or clear=true to clear it.";
  }
  if (!d.allDistricts.has(did)) {
    return `Error: district ${did} not found`;
  }
  d.setBridgeGraphMeta({ startDistrictId: did });
  d.persistWorkspace();
  d.broadcastToWeb({ type: "bridges.updated" });
  d.log("CHAT_ACTION", `set_bridge_start: ${did}`);
  return `Bridge pipeline start set to district ${did}`;
}

export function execApprovePendingTasks(args: ApprovePendingTasksArgs, d: ChatActionDeps): string {
  const pending = d.approvalGate.listPending();
  if (pending.length === 0) {
    return "No tasks are pending approval.";
  }

  let toApprove: typeof pending;
  if (args.approveAllPending === true) {
    toApprove = [...pending];
  } else if (Array.isArray(args.taskIds) && args.taskIds.length > 0) {
    const idSet = new Set(args.taskIds.map((x) => String(x).trim()).filter(Boolean));
    toApprove = pending.filter((t) => idSet.has(t.id));
    const notPending = [...idSet].filter((id) => !pending.some((t) => t.id === id));
    if (toApprove.length === 0) {
      return `Error: none of the given task ids are pending approval. Unknown or not pending: ${notPending.join(", ") || "(empty)"}. Current pending: ${pending.map((t) => `${t.id}: ${t.title}`).join("; ")}`;
    }
    if (notPending.length > 0) {
      d.log("CHAT_ACTION", `approve_pending_tasks: skipped ids not in pending: ${notPending.join(", ")}`);
    }
  } else if (typeof args.titleSubstring === "string" && args.titleSubstring.trim()) {
    const sub = args.titleSubstring.trim().toLowerCase();
    toApprove = pending.filter((t) => String(t.title ?? "").toLowerCase().includes(sub));
    if (toApprove.length === 0) {
      return `No pending tasks matched title substring "${args.titleSubstring.trim()}". Pending: ${pending.map((p) => `${p.id}: ${p.title}`).join("; ")}`;
    }
  } else {
    return "Error: specify taskIds (non-empty array), approveAllPending: true, or titleSubstring.";
  }

  const approved: BeeTask[] = [];
  for (const t of toApprove) {
    const a = d.approvalGate.approve(t.id);
    if (a) {
      approved.push(a);
      d.auditLog.record({
        type: "bee.job.approved",
        payload: { jobId: t.id, source: "chat" },
      });
    }
  }

  if (approved.length === 0) {
    return "Could not approve any tasks (they may no longer be pending).";
  }

  d.log("CHAT_ACTION", `approve_pending_tasks: ${approved.length} job(s)`);
  d.broadcastToWeb({ type: "jobs.updated" });

  const runQueue = args.runQueue !== false;
  if (runQueue && approved.length > 0 && d.runAutoApprovedChatTasks) {
    d.runAutoApprovedChatTasks(approved);
  }

  const parts = [
    `Approved ${approved.length} task(s): ${approved.map((t) => `${t.id} "${t.title}"`).join(", ")}.`,
  ];
  parts.push(
    runQueue && d.runAutoApprovedChatTasks
      ? "Execution queue started for these tasks."
      : runQueue
        ? "Approved; queue runner was not available — start Run queue from the web UI if needed."
        : "Execution was not started (runQueue: false). Start Run queue from the web UI when ready.",
  );
  return parts.join(" ");
}

export function execRunTasks(args: RunTasksArgs, d: ChatActionDeps): string {
  const allTasks = [...d.allTasks.values()];

  let candidates: BeeTask[];
  if (Array.isArray(args.taskIds) && args.taskIds.length > 0) {
    const idSet = new Set(args.taskIds.map((x) => String(x).trim()).filter(Boolean));
    candidates = allTasks.filter((t) => idSet.has(t.id));
    if (candidates.length === 0) {
      return `Error: none of the given task ids were found. Provided: ${[...idSet].join(", ")}`;
    }
  } else if (args.districtId) {
    candidates = allTasks.filter((t) => t.districtId === args.districtId);
    if (candidates.length === 0) {
      return `Error: no tasks found in district ${args.districtId}.`;
    }
  } else if (typeof args.titleSubstring === "string" && args.titleSubstring.trim()) {
    const sub = args.titleSubstring.trim().toLowerCase();
    candidates = allTasks.filter((t) => String(t.title ?? "").toLowerCase().includes(sub));
    if (candidates.length === 0) {
      return `No tasks matched title substring "${args.titleSubstring.trim()}". Available: ${allTasks.slice(0, 10).map((t) => `${t.id}: ${t.title}`).join("; ")}`;
    }
  } else {
    return "Error: specify taskIds, districtId, or titleSubstring.";
  }

  const completed = candidates.filter((t) => t.status === "done");
  const runnable = candidates.filter((t) => t.status === "waiting");
  if (runnable.length === 0) {
    const statuses = candidates.map((t) => `${t.id} (${t.status})`).join(", ");
    if (completed.length > 0) {
      return `No waiting tasks to run. ${completed.length} task(s) already completed/failed: ${statuses}. To add follow-up work (review, fix, improve), use setup_plan with targetDistrictId to create a new bee+task, then run_tasks with that specific new task id.`;
    }
    return `No runnable (waiting) tasks found among the matched tasks. Current statuses: ${statuses}`;
  }

  for (const t of runnable) {
    if (!d.approvalGate.isTracked(t.id)) {
      d.approvalGate.seedAutoApproved(t);
    }
  }

  if (d.runAutoApprovedChatTasks) {
    d.runAutoApprovedChatTasks(runnable);
    d.log("CHAT_ACTION", `run_tasks: started ${runnable.length} task(s): ${runnable.map((t) => t.id).join(", ")}`);
    return `Execution started for ${runnable.length} task(s): ${runnable.map((t) => `${t.id} "${t.title}"`).join(", ")}. Check the Jobs page for live logs.`;
  }
  return `${runnable.length} task(s) are runnable but queue runner is not available. Start Run queue from the web UI.`;
}

export function execListDistricts(d: ChatActionDeps): string {
  const districts = [...d.allDistricts.values()];
  if (districts.length === 0) return "No districts exist yet.";
  const lines = districts.map((dist) => {
    const taskCount = [...d.allTasks.values()].filter((t) => t.districtId === dist.id).length;
    const beeCount = dist.beeRosterIds?.length ?? 0;
    const w = dist.waggle ? `waggle=${dist.waggle.mode}(${dist.waggle.enabled ? "on" : "off"})` : "waggle=off";
    return `- "${dist.title}" id=${dist.id} status=${dist.status} tasks=${taskCount} bees=${beeCount} ${w}`;
  });
  return lines.join("\n");
}

export function execListBridges(d: ChatActionDeps): string {
  const bridges = [...d.districtBridges.values()];
  if (bridges.length === 0) return "No bridges configured.";
  const start = d.getBridgeGraphMeta().startDistrictId;
  const lines = bridges.map((b) =>
    `- ${b.id}: "${b.label}" | ${b.fromDistrictId} → ${b.toDistrictId} | ${b.direction} | ${b.status}`,
  );
  return [`Pipeline start district: ${start ?? "(none)"}`, ...lines].join("\n");
}

export function runChatTool(name: string, args: Record<string, unknown>, d: ChatActionDeps): string {
  switch (name) {
    case "setup_plan":
      return execSetupPlan(args as unknown as SetupPlanArgs, d);
    case "update_district_settings":
      return execUpdateDistrictSettings(args as unknown as UpdateDistrictSettingsArgs, d);
    case "create_bridge":
      return execCreateBridge(args as unknown as CreateBridgeArgs, d);
    case "set_bridge_pipeline_start":
      return execSetBridgeStart(args as unknown as SetBridgeStartArgs, d);
    case "list_districts":
      return execListDistricts(d);
    case "list_bridges":
      return execListBridges(d);
    case "approve_pending_tasks":
      return execApprovePendingTasks(args as unknown as ApprovePendingTasksArgs, d);
    case "run_tasks":
      return execRunTasks(args as unknown as RunTasksArgs, d);
    default:
      return `Unknown tool: ${name}`;
  }
}

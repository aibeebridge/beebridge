import fs from "node:fs";
import path from "node:path";
import type {
  AuditEvent,
  BeeDistrict,
  BeePersona,
  BeeTask,
  BridgeGraphMeta,
  PipelineRunRecord,
  DistrictBridge,
  TaskConversation,
  TaskSchedule,
  TeamPlan,
} from "@beebridge/core";
import { ensureDir, atomicWriteJson, safeReadJson } from "./safe-fs.js";

export type WorkspaceSnapshot = {
  latestTeamPlan: TeamPlan | null;
  districts: BeeDistrict[];
  tasks: BeeTask[];
  schedules: Record<string, TaskSchedule>;
  bridges: DistrictBridge[];
  bridgeGraphMeta: BridgeGraphMeta;
  conversations: TaskConversation[];
  /** Past Bee/Flower runs per taskId (newest session first in each array). */
  conversationArchives?: Record<string, TaskConversation[]>;
  auditEvents: AuditEvent[];
};

type DistrictMeta = {
  district: BeeDistrict;
  bees: BeePersona[];
};

/** Tasks without a district (or pointing at a removed district) are bucketed here on disk. */
export const UNASSIGNED_DISTRICT_ID = "district-unassigned";

function taskDistrictKey(task: BeeTask): string {
  const raw = task.districtId?.trim();
  return raw && raw.length > 0 ? raw : UNASSIGNED_DISTRICT_ID;
}

const readJsonFile = safeReadJson;
const writeJsonFile = atomicWriteJson;

function slugify(name: string): string {
  const base = String(name ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "unknown";
}

function defaultDistrictFromTask(task: BeeTask): BeeDistrict {
  const id = taskDistrictKey(task);
  const title =
    id === UNASSIGNED_DISTRICT_ID
      ? "Unassigned Tasks"
      : id
          .replace("district-", "")
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) + " District";
  return {
    id,
    cityId: task.cityId,
    status: "active",
    title,
    objective: task.title,
  };
}

const DEFAULT_BRIDGE_GRAPH_META: BridgeGraphMeta = { startDistrictId: null };

const WORKSPACE_LOAD_PERF =
  process.env.BEEBRIDGE_GATEWAY_PERF_LOG === "1" || process.env.BEEBRIDGE_GATEWAY_PERF_LOG === "true";

function workspaceLoadPerf(label: string, t0: number, segmentStart: number): number {
  if (!WORKSPACE_LOAD_PERF) return segmentStart;
  const now = performance.now();
  const seg = (now - segmentStart).toFixed(1);
  const cum = (now - t0).toFixed(1);
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] [PERF] workspace.load:${label} segment ${seg}ms (cumulative ${cum}ms)`);
  return now;
}

export class WorkspaceStore {
  private readonly root: string;
  private readonly districtsDir: string;
  private readonly districtsIndex: string;
  private readonly bridgesFile: string;
  private readonly bridgeGraphMetaFile: string;
  private readonly pipelineRunsFile: string;
  private readonly schedulesFile: string;
  private readonly conversationsFile: string;
  private readonly conversationArchivesFile: string;
  private readonly auditFile: string;
  private readonly teamPlanFile: string;

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
    this.districtsDir = path.join(workspaceRoot, "districts");
    this.districtsIndex = path.join(workspaceRoot, "districts-index.json");
    this.bridgesFile = path.join(workspaceRoot, "bridges", "bridges.json");
    this.bridgeGraphMetaFile = path.join(workspaceRoot, "bridges", "bridge-graph-meta.json");
    this.pipelineRunsFile = path.join(workspaceRoot, "bridges", "pipeline-runs.json");
    this.schedulesFile = path.join(workspaceRoot, "jobs", "schedules.json");
    this.conversationsFile = path.join(workspaceRoot, "jobs", "conversations.json");
    this.conversationArchivesFile = path.join(workspaceRoot, "jobs", "conversation-archives.json");
    this.auditFile = path.join(workspaceRoot, "activity", "audit.json");
    this.teamPlanFile = path.join(workspaceRoot, "team", "latest-team-plan.json");
  }

  load(): WorkspaceSnapshot {
    const t0 = performance.now();
    let mark = t0;

    const latestTeamPlan = readJsonFile<TeamPlan | null>(this.teamPlanFile, null);
    const schedules = readJsonFile<Record<string, TaskSchedule>>(this.schedulesFile, {});
    const bridges = readJsonFile<DistrictBridge[]>(this.bridgesFile, []);
    const bridgeGraphMetaRaw = readJsonFile<BridgeGraphMeta | null>(this.bridgeGraphMetaFile, null);
    const bridgeGraphMeta: BridgeGraphMeta =
      bridgeGraphMetaRaw && typeof bridgeGraphMetaRaw === "object"
        ? {
            startDistrictId:
              typeof bridgeGraphMetaRaw.startDistrictId === "string"
                ? bridgeGraphMetaRaw.startDistrictId
                : bridgeGraphMetaRaw.startDistrictId === null
                  ? null
                  : DEFAULT_BRIDGE_GRAPH_META.startDistrictId,
          }
        : DEFAULT_BRIDGE_GRAPH_META;
    const conversations = readJsonFile<TaskConversation[]>(this.conversationsFile, []);
    const conversationArchives = readJsonFile<Record<string, TaskConversation[]>>(
      this.conversationArchivesFile,
      {},
    );
    mark = workspaceLoadPerf("json: teamPlan schedules bridges meta conversations archives", t0, mark);

    const auditEvents = readJsonFile<AuditEvent[]>(this.auditFile, []);
    mark = workspaceLoadPerf("json: activity/audit.json", t0, mark);

    let districts = readJsonFile<BeeDistrict[]>(this.districtsIndex, []);

    if (districts.length === 0 && latestTeamPlan?.districts) {
      districts = latestTeamPlan.districts;
    }

    mark = workspaceLoadPerf("json: districts-index", t0, mark);

    const tasks: BeeTask[] = [];
    if (fs.existsSync(this.districtsDir)) {
      const entries = fs.readdirSync(this.districtsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const tasksFile = path.join(this.districtsDir, entry.name, "tasks.json");
        const districtTasks = readJsonFile<BeeTask[]>(tasksFile, []);
        tasks.push(...districtTasks);
      }
    }

    workspaceLoadPerf("districts/*/tasks.json scan", t0, mark);

    return {
      latestTeamPlan,
      districts,
      tasks,
      schedules,
      bridges,
      bridgeGraphMeta,
      conversations,
      conversationArchives,
      auditEvents,
    };
  }

  save(snapshot: WorkspaceSnapshot): void {
    const districtTaskMap = new Map<string, BeeTask[]>();
    for (const task of snapshot.tasks) {
      const key = taskDistrictKey(task);
      const list = districtTaskMap.get(key) ?? [];
      list.push(task);
      districtTaskMap.set(key, list);
    }

    const allDistrictIds = new Set(snapshot.districts.map((d) => d.id));
    for (const districtId of districtTaskMap.keys()) {
      allDistrictIds.add(districtId);
    }

    const districtMetaMap = new Map<string, DistrictMeta>();
    for (const districtId of allDistrictIds) {
      const explicit = snapshot.districts.find((d) => d.id === districtId);
      const planDistrict = snapshot.latestTeamPlan?.districts.find((d) => d.id === districtId);
      const fallbackTask = districtTaskMap.get(districtId)?.[0];

      const district = explicit ?? planDistrict ?? (fallbackTask ? defaultDistrictFromTask(fallbackTask) : null);
      if (!district) continue;

      const bees: BeePersona[] = [];
      const tasksInDistrict = districtTaskMap.get(districtId) ?? [];
      const beeIds = new Set<string>();
      for (const t of tasksInDistrict) {
        if (t.personaId) beeIds.add(t.personaId);
        if (t.bee) beeIds.add(t.bee);
      }
      for (const id of district.beeRosterIds ?? []) beeIds.add(id);
      const taskIdInDistrict = new Set(tasksInDistrict.map((t) => t.id));
      for (const bee of snapshot.latestTeamPlan?.bees ?? []) {
        if (bee.scopedTaskId && taskIdInDistrict.has(bee.scopedTaskId)) beeIds.add(bee.id);
      }
      for (const bee of snapshot.latestTeamPlan?.bees ?? []) {
        if (beeIds.has(bee.id)) bees.push(bee);
      }
      districtMetaMap.set(districtId, { district, bees });
    }

    ensureDir(this.districtsDir);
    const wantedFolders = new Set<string>();
    for (const [districtId, meta] of districtMetaMap.entries()) {
      const folderName = `${slugify(districtId)}__${districtId}`;
      wantedFolders.add(folderName);
      const districtDir = path.join(this.districtsDir, folderName);
      ensureDir(districtDir);
      writeJsonFile(path.join(districtDir, "district.json"), meta.district);
      writeJsonFile(path.join(districtDir, "bees.json"), meta.bees);
      writeJsonFile(path.join(districtDir, "tasks.json"), districtTaskMap.get(districtId) ?? []);
    }

    const existing = fs.existsSync(this.districtsDir) ? fs.readdirSync(this.districtsDir, { withFileTypes: true }) : [];
    for (const entry of existing) {
      if (!entry.isDirectory()) continue;
      if (!wantedFolders.has(entry.name)) {
        fs.rmSync(path.join(this.districtsDir, entry.name), { recursive: true, force: true });
      }
    }

    const indexDistricts = [...snapshot.districts];
    const indexIds = new Set(indexDistricts.map((d) => d.id));
    for (const [id, meta] of districtMetaMap.entries()) {
      if (!indexIds.has(id)) {
        indexDistricts.push(meta.district);
        indexIds.add(id);
      }
    }
    writeJsonFile(this.districtsIndex, indexDistricts);
    writeJsonFile(this.teamPlanFile, snapshot.latestTeamPlan);
    writeJsonFile(this.schedulesFile, snapshot.schedules);
    writeJsonFile(this.bridgesFile, snapshot.bridges);
    writeJsonFile(this.bridgeGraphMetaFile, snapshot.bridgeGraphMeta ?? DEFAULT_BRIDGE_GRAPH_META);
    writeJsonFile(this.conversationsFile, snapshot.conversations);
    writeJsonFile(this.conversationArchivesFile, snapshot.conversationArchives ?? {});
    const MAX_AUDIT_EVENTS = 1000;
    const auditToSave = snapshot.auditEvents.length > MAX_AUDIT_EVENTS
      ? snapshot.auditEvents.slice(-MAX_AUDIT_EVENTS)
      : snapshot.auditEvents;
    writeJsonFile(this.auditFile, auditToSave);
  }

  loadPipelineRuns(): PipelineRunRecord[] {
    const raw = readJsonFile<PipelineRunRecord[]>(this.pipelineRunsFile, []);
    return Array.isArray(raw) ? raw : [];
  }

  /** Prepend one run; cap list length to avoid unbounded growth. */
  appendPipelineRun(run: PipelineRunRecord): void {
    const list = this.loadPipelineRuns();
    list.unshift(run);
    const max = 200;
    if (list.length > max) list.length = max;
    writeJsonFile(this.pipelineRunsFile, list);
  }
}

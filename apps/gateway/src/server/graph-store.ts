import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, safeReadJson } from "./safe-fs.js";

export type NodeType = "district" | "task" | "bee";
export type EdgeType = "contains" | "assigned_to" | "bridge" | "depends_on";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  label?: string;
  data: Record<string, unknown>;
}

interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private outEdges = new Map<string, Set<string>>();
  private inEdges = new Map<string, Set<string>>();
  private readonly graphFile: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceRoot: string) {
    this.graphFile = path.join(workspaceRoot, "graph.json");
    this.loadFromDisk();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) { this.dirty = false; this.saveToDisk(); }
    }, 100);
  }

  flushSync(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty) { this.dirty = false; this.saveToDisk(); }
  }

  /** Replace all in-memory state (and persist). Call before a full rebuild from workspace truth. */
  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.scheduleSave();
  }

  addNode(type: NodeType, id: string, label: string, data: Record<string, unknown> = {}): GraphNode {
    const node: GraphNode = { id, type, label, data };
    this.nodes.set(id, node);
    this.scheduleSave();
    return node;
  }

  updateNode(id: string, patch: { label?: string; data?: Record<string, unknown> }): GraphNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    if (patch.label !== undefined) node.label = patch.label;
    if (patch.data !== undefined) node.data = { ...node.data, ...patch.data };
    this.scheduleSave();
    return node;
  }

  removeNode(id: string): boolean {
    if (!this.nodes.delete(id)) return false;
    const outIds = this.outEdges.get(id);
    if (outIds) {
      for (const eid of outIds) {
        const edge = this.edges.get(eid);
        if (edge) this.inEdges.get(edge.to)?.delete(eid);
        this.edges.delete(eid);
      }
      this.outEdges.delete(id);
    }
    const inIds = this.inEdges.get(id);
    if (inIds) {
      for (const eid of inIds) {
        const edge = this.edges.get(eid);
        if (edge) this.outEdges.get(edge.from)?.delete(eid);
        this.edges.delete(eid);
      }
      this.inEdges.delete(id);
    }
    this.scheduleSave();
    return true;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  addEdge(type: EdgeType, from: string, to: string, label?: string, data: Record<string, unknown> = {}): GraphEdge {
    const id = `edge-${type}-${from}-${to}`;
    const existing = this.edges.get(id);
    if (existing) return existing;

    const edge: GraphEdge = { id, type, from, to, label, data };
    this.edges.set(id, edge);

    if (!this.outEdges.has(from)) this.outEdges.set(from, new Set());
    this.outEdges.get(from)!.add(id);

    if (!this.inEdges.has(to)) this.inEdges.set(to, new Set());
    this.inEdges.get(to)!.add(id);

    this.scheduleSave();
    return edge;
  }

  removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this.outEdges.get(edge.from)?.delete(id);
    this.inEdges.get(edge.to)?.delete(id);
    this.scheduleSave();
    return true;
  }

  removeEdgesBetween(from: string, to: string, type?: EdgeType): void {
    const outIds = this.outEdges.get(from);
    if (!outIds) return;
    for (const eid of [...outIds]) {
      const edge = this.edges.get(eid);
      if (edge && edge.to === to && (!type || edge.type === type)) {
        this.removeEdge(eid);
      }
    }
  }

  query(nodeType?: NodeType, filters?: Record<string, unknown>): GraphNode[] {
    let results = [...this.nodes.values()];
    if (nodeType) results = results.filter((n) => n.type === nodeType);
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        results = results.filter((n) => n.data[key] === value);
      }
    }
    return results;
  }

  neighbors(nodeId: string, edgeType?: EdgeType): GraphNode[] {
    const result: GraphNode[] = [];
    const seen = new Set<string>();

    const outIds = this.outEdges.get(nodeId) ?? new Set();
    for (const eid of outIds) {
      const edge = this.edges.get(eid);
      if (!edge || (edgeType && edge.type !== edgeType)) continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = this.nodes.get(edge.to);
      if (node) result.push(node);
    }

    const inIds = this.inEdges.get(nodeId) ?? new Set();
    for (const eid of inIds) {
      const edge = this.edges.get(eid);
      if (!edge || (edgeType && edge.type !== edgeType)) continue;
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      const node = this.nodes.get(edge.from);
      if (node) result.push(node);
    }

    return result;
  }

  edgesOf(nodeId: string, edgeType?: EdgeType): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const eid of this.outEdges.get(nodeId) ?? []) {
      const e = this.edges.get(eid);
      if (e && (!edgeType || e.type === edgeType)) result.push(e);
    }
    for (const eid of this.inEdges.get(nodeId) ?? []) {
      const e = this.edges.get(eid);
      if (e && (!edgeType || e.type === edgeType)) result.push(e);
    }
    return result;
  }

  path(fromId: string, toId: string): string[] | null {
    if (fromId === toId) return [fromId];
    const visited = new Set<string>();
    const queue: string[][] = [[fromId]];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const last = current[current.length - 1];
      for (const n of this.neighbors(last)) {
        if (n.id === toId) return [...current, n.id];
        if (!visited.has(n.id)) {
          visited.add(n.id);
          queue.push([...current, n.id]);
        }
      }
    }
    return null;
  }

  /** Produce a compact text summary for LLM context */
  summarize(): string {
    const lines: string[] = [];
    const districtNodes = this.query("district");
    const taskNodes = this.query("task");
    const beeNodes = this.query("bee");

    lines.push(`Districts: ${districtNodes.length}, Tasks: ${taskNodes.length}, Bees: ${beeNodes.length}`);
    lines.push("");

    for (const d of districtNodes) {
      const tasks = this.neighbors(d.id, "contains");
      const bridgeEdges = this.edgesOf(d.id, "bridge");
      lines.push(`[District] ${d.label} (${d.id}) - ${tasks.length} tasks, ${bridgeEdges.length} bridges`);
      if (d.data.objective) lines.push(`  objective: ${d.data.objective}`);
      if (d.data.status) lines.push(`  status: ${d.data.status}`);
      for (const t of tasks) {
        const bees = this.neighbors(t.id, "assigned_to");
        const beeNames = bees.map((b) => b.label).join(", ");
        lines.push(`  [Task] ${t.label} (${t.id})${beeNames ? ` -> ${beeNames}` : ""}`);
      }
      for (const be of bridgeEdges) {
        const other = be.from === d.id ? be.to : be.from;
        lines.push(`  [Bridge] ${be.label ?? be.id} -> ${other}`);
      }
    }

    for (const b of beeNodes) {
      const tasks = this.neighbors(b.id, "assigned_to");
      lines.push(`[Bee] ${b.label} (${b.id}) - ${tasks.length} tasks`);
    }

    return lines.join("\n");
  }

  toJSON(): GraphSnapshot {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  fromJSON(snapshot: GraphSnapshot): void {
    this.nodes.clear();
    this.edges.clear();
    this.outEdges.clear();
    this.inEdges.clear();

    for (const node of snapshot.nodes) {
      this.nodes.set(node.id, node);
    }
    for (const edge of snapshot.edges) {
      this.edges.set(edge.id, edge);
      if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, new Set());
      this.outEdges.get(edge.from)!.add(edge.id);
      if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, new Set());
      this.inEdges.get(edge.to)!.add(edge.id);
    }
  }

  private saveToDisk(): void {
    try {
      atomicWriteJson(this.graphFile, this.toJSON());
    } catch {
      // best-effort
    }
  }

  private loadFromDisk(): void {
    const data = safeReadJson<GraphSnapshot | null>(this.graphFile, null);
    if (data?.nodes && data?.edges) this.fromJSON(data);
  }
}

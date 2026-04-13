"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  type Node,
  type Edge,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodeDrag,
  type EdgeTypes,
  type EdgeProps,
  type NodeTypes,
  type NodeProps,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const graphCss = `
.react-flow__edge.selected .react-flow__edge-path {
  stroke: #ef4444 !important;
  stroke-width: 3px !important;
}
.react-flow__edge:hover .react-flow__edge-path {
  stroke: #f87171 !important;
  stroke-width: 3px !important;
}
`;

export interface BeeGraphTask {
  id: string;
  title: string;
  bee: string;
  status: string;
  personaId?: string;
  personaName?: string;
  personaRole?: string;
  dependsOn?: string[];
}

interface BeeGraphEditorProps {
  tasks: BeeGraphTask[];
  onGraphChange: (edges: Array<{ from: string; to: string }>) => Promise<void> | void;
  readonly?: boolean;
  positions?: Record<string, { x: number; y: number }>;
  onNodeClick?: (nodeId: string) => void;
  onNodeDragStop?: (nodeId: string, center: { x: number; y: number }) => void;
  onEdgeClick?: (edgeId: string) => void;
  edgeDeleteMode?: "keyboard" | "button" | "both";
  selectionOnDrag?: boolean;
  onSelectionChange?: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
}

const STATUS_COLORS: Record<string, string> = {
  waiting: "#6b7280",
  assigned: "#3b82f6",
  working: "#f59e0b",
  review: "#8b5cf6",
  done: "#22c55e",
};

const WAVE_COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#22c55e", "#ef4444", "#ec4899", "#14b8a6"];

interface WaveInfo {
  wave: number;
  totalWaves: number;
  parallelCount: number;
}

function computeWaves(nodeIds: string[], edges: Edge[]): Map<string, WaveInfo> {
  const ids = new Set(nodeIds);
  const inDeps = new Map<string, Set<string>>();
  const outDeps = new Map<string, string[]>();
  for (const id of ids) {
    inDeps.set(id, new Set());
    outDeps.set(id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    inDeps.get(e.target)!.add(e.source);
    outDeps.get(e.source)!.push(e.target);
  }

  const waves: string[][] = [];
  const placed = new Set<string>();
  const indegree = new Map<string, number>();
  for (const [id, deps] of inDeps) indegree.set(id, deps.size);

  while (placed.size < ids.size) {
    const wave: string[] = [];
    for (const id of ids) {
      if (placed.has(id)) continue;
      if ((indegree.get(id) ?? 0) === 0) wave.push(id);
    }
    if (wave.length === 0) break;
    for (const id of wave) {
      placed.add(id);
      for (const dep of outDeps.get(id) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
      }
    }
    waves.push(wave);
  }

  const result = new Map<string, WaveInfo>();
  for (let wi = 0; wi < waves.length; wi++) {
    for (const id of waves[wi]) {
      result.set(id, { wave: wi, totalWaves: waves.length, parallelCount: waves[wi].length });
    }
  }
  for (const id of ids) {
    if (!result.has(id)) {
      result.set(id, { wave: waves.length, totalWaves: waves.length + 1, parallelCount: 1 });
    }
  }
  return result;
}

function BeeNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    bee: string;
    role: string;
    status: string;
    waveInfo?: WaveInfo;
  };
  const borderColor = STATUS_COLORS[d.status] ?? "#6b7280";
  const wi = d.waveInfo;
  const waveBadgeColor = wi ? WAVE_COLORS[wi.wave % WAVE_COLORS.length] : "#6b7280";
  const stepLabel = wi
    ? wi.parallelCount > 1
      ? `Step ${wi.wave + 1} (${wi.parallelCount}개 병렬)`
      : `Step ${wi.wave + 1} (순차)`
    : "";

  return (
    <div
      style={{
        padding: "10px 16px",
        borderRadius: 8,
        border: `2px solid ${borderColor}`,
        background: "var(--bg-card, #1e1e2e)",
        color: "var(--text-primary, #e0e0e0)",
        minWidth: 160,
        fontSize: 13,
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: borderColor }} />
      {wi && (
        <div
          style={{
            position: "absolute",
            top: -10,
            right: -6,
            background: waveBadgeColor,
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            borderRadius: 10,
            padding: "1px 7px",
            lineHeight: "16px",
            whiteSpace: "nowrap",
          }}
        >
          {wi.wave + 1}
        </div>
      )}
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{d.bee || d.label}</div>
      {d.role && <div style={{ fontSize: 11, opacity: 0.7 }}>{d.role}</div>}
      <div style={{ fontSize: 10, marginTop: 4, opacity: 0.5 }}>{d.status}</div>
      {stepLabel && (
        <div
          style={{
            fontSize: 10,
            marginTop: 4,
            color: waveBadgeColor,
            fontWeight: 600,
          }}
        >
          {stepLabel}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: borderColor }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { beeNode: BeeNode };

function BeeEdge(
  props: EdgeProps & { canDelete: boolean; onDelete: (edgeId: string) => void },
) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    markerStart,
    style,
    selected,
    canDelete,
    onDelete,
  } = props;
  const [path, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} style={style} />
      {selected && canDelete && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(id);
            }}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              border: "1px solid #ef4444",
              background: "#ef4444",
              color: "#fff",
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.2,
              fontWeight: 700,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function layoutNodes(tasks: BeeGraphTask[], positions?: Record<string, { x: number; y: number }>): Node[] {
  const withPosition = (id: string, fallback: { x: number; y: number }, data: Record<string, unknown>): Node => {
    const p = positions?.[id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return { id, type: "beeNode", position: { x: p.x, y: p.y }, data };
    }
    return { id, type: "beeNode", position: fallback, data };
  };

  const hasDeps = tasks.some((t) => t.dependsOn && t.dependsOn.length > 0);

  if (!hasDeps) {
    return tasks.map((t, i) =>
      withPosition(t.id, { x: i * 220, y: 80 }, {
        label: t.title,
        bee: t.personaName || t.bee,
        role: t.personaRole || "",
        status: t.status,
      }),
    );
  }

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const taskIds = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of (t.dependsOn ?? []).filter((dep) => taskIds.has(dep))) {
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(d)!.push(t.id);
    }
  }

  const waves: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < tasks.length) {
    const wave: string[] = [];
    for (const t of tasks) {
      if (placed.has(t.id)) continue;
      if ((indegree.get(t.id) ?? 0) === 0) wave.push(t.id);
    }
    if (wave.length === 0) break;
    for (const id of wave) {
      placed.add(id);
      for (const dep of dependents.get(id) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
      }
    }
    waves.push(wave);
  }

  const nodes: Node[] = [];
  for (let wi = 0; wi < waves.length; wi++) {
    for (let ni = 0; ni < waves[wi].length; ni++) {
      const id = waves[wi][ni];
      const t = taskMap.get(id);
      if (!t) continue;
      nodes.push(
        withPosition(t.id, { x: wi * 260, y: ni * 120 }, {
          label: t.title,
          bee: t.personaName || t.bee,
          role: t.personaRole || "",
          status: t.status,
        }),
      );
    }
  }
  return nodes;
}

function buildEdges(tasks: BeeGraphTask[], selectable: boolean): Edge[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const edges: Edge[] = [];
  for (const t of tasks) {
    for (const dep of (t.dependsOn ?? []).filter((d) => taskIds.has(d))) {
      edges.push({
        id: `${dep}->${t.id}`,
        type: "beeEdge",
        source: dep,
        target: t.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#6b7280", strokeWidth: 2 },
        animated: t.status === "working",
        selectable,
        interactionWidth: 20,
      });
    }
  }
  return edges;
}

function edgesToGraphEdges(edges: Edge[]): Array<{ from: string; to: string }> {
  return edges.map((e) => ({ from: e.source, to: e.target }));
}

function wouldCreateCycle(edges: Edge[], newSource: string, newTarget: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const srcList = adj.get(newSource) ?? [];
  srcList.push(newTarget);
  adj.set(newSource, srcList);

  const visited = new Set<string>();
  const stack = [newSource];
  const inStack = new Set<string>([newSource]);

  function dfs(node: string): boolean {
    if (visited.has(node)) return false;
    visited.add(node);
    for (const next of adj.get(node) ?? []) {
      if (inStack.has(next)) return true;
      inStack.add(next);
      if (dfs(next)) return true;
      inStack.delete(next);
    }
    return false;
  }

  return dfs(newTarget);
}

function applyWaveInfo(nodes: Node[], edges: Edge[]): Node[] {
  const nodeIds = nodes.map((n) => n.id);
  const waveMap = computeWaves(nodeIds, edges);
  return nodes.map((n) => ({
    ...n,
    data: { ...n.data, waveInfo: waveMap.get(n.id) },
  }));
}

function InnerEditor({
  tasks,
  onGraphChange,
  readonly,
  positions,
  onNodeClick,
  onNodeDragStop,
  onEdgeClick,
  edgeDeleteMode = "keyboard",
  selectionOnDrag = false,
  onSelectionChange,
}: BeeGraphEditorProps) {
  const initialNodes = useMemo(() => layoutNodes(tasks, positions), [tasks, positions]);
  const initialEdges = useMemo(() => buildEdges(tasks, !readonly), [tasks, readonly]);

  const [nodes, setNodes, onNodesChange] = useNodesState(
    applyWaveInfo(initialNodes, initialEdges),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const refreshWaves = useCallback(
    (currentEdges: Edge[]) => {
      setNodes((nds) => applyWaveInfo(nds, currentEdges));
    },
    [setNodes],
  );

  useEffect(() => {
    refreshWaves(edges);
  }, [edges, refreshWaves]);

  useEffect(() => {
    setNodes(applyWaveInfo(initialNodes, edges));
  }, [initialNodes, edges, setNodes]);

  const deleteEdgesByIds = useCallback(
    (ids: Set<string>) => {
      if (readonly || ids.size === 0) return;
      setEdges((eds) => {
        const next = eds.filter((e) => !ids.has(e.id));
        setTimeout(() => onGraphChange(edgesToGraphEdges(next)), 0);
        return next;
      });
    },
    [readonly, setEdges, onGraphChange],
  );

  const onConnect: OnConnect = useCallback(
    (params) => {
      if (readonly) return;
      if (!params.source || !params.target) return;
      if (params.source === params.target) return;

      setEdges((eds) => {
        if (wouldCreateCycle(eds, params.source!, params.target!)) return eds;

        const next = addEdge(
          {
            ...params,
            type: "beeEdge",
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: "#6b7280", strokeWidth: 2 },
            selectable: true,
            interactionWidth: 20,
          },
          eds,
        );
        setTimeout(() => onGraphChange(edgesToGraphEdges(next)), 0);
        return next;
      });
    },
    [readonly, setEdges, onGraphChange],
  );

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (deleted) => {
      if (readonly) return;
      const ids = new Set(deleted.map((e) => e.id));
      deleteEdgesByIds(ids);
    },
    [readonly, deleteEdgesByIds],
  );

  const onDragStop: OnNodeDrag = useCallback(
    (_ev, node) => {
      onNodeDragStop?.(node.id, { x: node.position.x, y: node.position.y });
    },
    [onNodeDragStop],
  );

  const edgeTypes = useMemo<EdgeTypes>(() => {
    const canDelete = !readonly && (edgeDeleteMode === "button" || edgeDeleteMode === "both");
    return {
      beeEdge: (props: EdgeProps) => (
        <BeeEdge
          {...props}
          canDelete={canDelete}
          onDelete={(edgeId) => deleteEdgesByIds(new Set([edgeId]))}
        />
      ),
    };
  }, [readonly, edgeDeleteMode, deleteEdgesByIds]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: graphCss }} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onDragStop}
        onNodeClick={(_ev, node) => onNodeClick?.(node.id)}
        onEdgeClick={(_ev, edge) => onEdgeClick?.(edge.id)}
        onSelectionChange={(selection) => {
          onSelectionChange?.({
            nodeIds: (selection.nodes ?? []).map((n) => n.id),
            edgeIds: (selection.edges ?? []).map((e) => e.id),
          });
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        selectionOnDrag={selectionOnDrag}
        deleteKeyCode={readonly || edgeDeleteMode === "button" ? null : ["Backspace", "Delete"]}
        edgesFocusable={!readonly}
        proOptions={{ hideAttribution: true }}
        style={{ background: "var(--bg-surface, #181825)" }}
      >
        <Background color="#333" gap={20} />
        <Controls />
      </ReactFlow>
    </>
  );
}

export default function BeeGraphEditor(props: BeeGraphEditorProps) {
  return (
    <ReactFlowProvider>
      <InnerEditor {...props} />
    </ReactFlowProvider>
  );
}

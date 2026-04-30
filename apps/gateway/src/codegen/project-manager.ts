import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BeeDistrict, CodeProjectRecord, CodeProjectSource, ResolvedCodeProject } from "@beebridge/core";

interface ProjectMeta {
  taskId: string;
  title: string;
  createdAt: string;
}

const META_FILE = ".beebridge-project.json";
const MAX_READ_SIZE = 50 * 1024; // 50 KB

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".turbo", ".cache", "coverage", ".nyc_output",
]);

export class ProjectManager {
  private readonly registryFile: string;

  constructor(private readonly projectsRoot: string, stateRoot?: string) {
    if (!fs.existsSync(projectsRoot)) {
      fs.mkdirSync(projectsRoot, { recursive: true });
    }
    this.registryFile = path.join(stateRoot ?? path.dirname(projectsRoot), "projects.json");
    const registryDir = path.dirname(this.registryFile);
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true });
    }
  }

  createDistrictProjectDir(districtId: string, title: string): string {
    const district: BeeDistrict = {
      id: districtId,
      title,
      objective: "",
      status: "active",
      cityId: "",
    };
    return this.resolveProjectForDistrict(district).path;
  }

  createProjectDir(taskId: string, title: string): string {
    const existing = this.loadRegistry().find((project) => project.id === `project-task-${taskId.replace(/^task-/, "").slice(0, 12)}`);
    if (existing) {
      return this.materializeRecord(existing).path;
    }
    const record = this.createProjectRecord({
      id: `project-task-${taskId.replace(/^task-/, "").slice(0, 12)}`,
      name: title,
      source: "auto",
    });
    const projectPath = this.materializeRecord(record).path;
    const metaPath = path.join(projectPath, META_FILE);
    if (!fs.existsSync(metaPath)) {
      const meta: ProjectMeta = { taskId, title, createdAt: new Date().toISOString() };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    }

    return projectPath;
  }

  listProjects(): CodeProjectRecord[] {
    return this.loadRegistry().map((project) => this.refreshStatus(project));
  }

  private loadRegistry(): CodeProjectRecord[] {
    const raw = readJsonFile<CodeProjectRecord[]>(this.registryFile, []);
    return Array.isArray(raw) ? raw.filter((project) => project && typeof project.id === "string") : [];
  }

  private saveRegistry(projects: CodeProjectRecord[]): void {
    writeJsonFile(this.registryFile, projects);
  }

  private createProjectRecord(input: CreateProjectInput): CodeProjectRecord {
    const projects = this.loadRegistry();
    const now = new Date().toISOString();
    const baseSlug = sanitizeSlug(input.name) || "project";
    const slug = this.uniqueDirSlug(baseSlug, projects);
    const record: CodeProjectRecord = {
      id: this.uniqueProjectId(input.id, projects),
      name: input.name || "Project",
      slug,
      path: path.join(this.projectsRoot, slug),
      source: input.source,
      status: "missing",
      createdAt: now,
      updatedAt: now,
      ...(input.externalProjectId ? { externalProjectId: input.externalProjectId } : {}),
    };
    projects.push(record);
    this.saveRegistry(projects);
    return record;
  }

  private materializeRecord(record: CodeProjectRecord): ResolvedCodeProject {
    const projects = this.loadRegistry();
    const idx = projects.findIndex((project) => project.id === record.id);
    const next = idx >= 0 ? { ...projects[idx] } : { ...record };
    const pathInsideRoot = this.isUnderProjectsRoot(path.resolve(next.path));
    if (!pathInsideRoot) {
      next.path = path.join(this.projectsRoot, this.uniqueDirSlug(next.slug || sanitizeSlug(next.name) || "project", projects));
    }
    if (!fs.existsSync(next.path)) {
      fs.mkdirSync(next.path, { recursive: true });
    }
    next.status = "ready";
    next.updatedAt = new Date().toISOString();
    if (idx >= 0) projects[idx] = next;
    else projects.push(next);
    this.saveRegistry(projects);
    return { id: next.id, name: next.name, path: next.path, source: next.source, status: next.status };
  }

  private refreshStatus(record: CodeProjectRecord): CodeProjectRecord {
    const next = { ...record };
    next.status = fs.existsSync(next.path) ? "ready" : "missing";
    return next;
  }

  private isUnderProjectsRoot(candidate: string): boolean {
    const root = path.resolve(this.projectsRoot);
    const resolved = path.resolve(candidate);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  private uniqueProjectId(baseId: string, projects: CodeProjectRecord[]): string {
    const clean = baseId.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || `project-${randomUUID().slice(0, 8)}`;
    const taken = new Set(projects.map((project) => project.id));
    if (!taken.has(clean)) return clean;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${clean}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${clean}-${randomUUID().slice(0, 8)}`;
  }

  private uniqueDirSlug(baseSlug: string, projects: CodeProjectRecord[]): string {
    const clean = sanitizeSlug(baseSlug) || "project";
    const taken = new Set(projects.map((project) => path.basename(project.path)));
    if (!taken.has(clean) && !fs.existsSync(path.join(this.projectsRoot, clean))) return clean;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${clean}-${i}`;
      if (!taken.has(candidate) && !fs.existsSync(path.join(this.projectsRoot, candidate))) return candidate;
    }
    return `${clean}-${randomUUID().slice(0, 8)}`;
  }

  resolveProjectForDistrict(district: BeeDistrict): ResolvedCodeProject {
    const now = new Date().toISOString();
    const projects = this.loadRegistry();

    if (district.codeProjectId) {
      const existing = projects.find((project) => project.id === district.codeProjectId);
      if (existing) {
        return this.materializeRecord(existing);
      }
      const imported = this.createProjectRecord({
        id: district.codeProjectId,
        name: district.title,
        source: "imported_workflow",
        externalProjectId: district.codeProjectId,
      });
      district.codeProjectId = imported.id;
      return this.materializeRecord(imported);
    }

    if (district.codeProjectPath) {
      const legacyPath = path.resolve(district.codeProjectPath);
      const underProjectsRoot = this.isUnderProjectsRoot(legacyPath);
      if (underProjectsRoot && fs.existsSync(legacyPath)) {
        const existing = projects.find((project) => path.resolve(project.path) === legacyPath);
        if (existing) {
          district.codeProjectId = existing.id;
          return this.materializeRecord(existing);
        }
        const slug = sanitizeSlug(district.title) || sanitizeSlug(path.basename(legacyPath));
        const record: CodeProjectRecord = {
          id: this.uniqueProjectId(`project-legacy-${slug || "project"}`, projects),
          name: district.title || path.basename(legacyPath),
          slug: this.uniqueDirSlug(slug || "project", projects),
          path: legacyPath,
          source: "legacy_path",
          status: "ready",
          createdAt: now,
          updatedAt: now,
        };
        projects.push(record);
        this.saveRegistry(projects);
        district.codeProjectId = record.id;
        return this.materializeRecord(record);
      }
      district.codeProjectPath = undefined;
    }

    const record = this.createProjectRecord({
      id: `project-district-${district.id.replace(/^district-/, "").slice(0, 12)}`,
      name: district.title,
      source: "auto",
    });
    district.codeProjectId = record.id;
    return this.materializeRecord(record);
  }

  importProjectHint(externalProjectId: string, name: string): CodeProjectRecord {
    const cleanExternalId = externalProjectId.trim();
    const existing = this.loadRegistry().find((project) =>
      project.externalProjectId === cleanExternalId && project.source === "imported_workflow"
    );
    if (existing) return existing;
    return this.createProjectRecord({
      id: `project-import-${sanitizeSlug(cleanExternalId) || randomUUID().slice(0, 8)}`,
      name,
      source: "imported_workflow",
      externalProjectId: cleanExternalId,
    });
  }

  getProjectRoot(taskId: string): string | null {
    if (!fs.existsSync(this.projectsRoot)) return null;
    const entries = fs.readdirSync(this.projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.projectsRoot, entry.name, META_FILE);
      try {
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as ProjectMeta;
        if (meta.taskId === taskId) return path.join(this.projectsRoot, entry.name);
      } catch {
        continue;
      }
    }
    return null;
  }

  resolveSafePath(projectRoot: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Absolute paths are not allowed: ${relativePath}`);
    }
    const normalized = path.normalize(relativePath);
    if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
      throw new Error(`Path traversal is not allowed: ${relativePath}`);
    }
    const resolved = path.resolve(projectRoot, normalized);
    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      throw new Error(`Path escapes project directory: ${relativePath}`);
    }
    return resolved;
  }

  writeFile(projectRoot: string, relativePath: string, content: string): string {
    const absPath = this.resolveSafePath(projectRoot, relativePath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absPath, content, "utf-8");
    return absPath;
  }

  readFile(projectRoot: string, relativePath: string, offset?: number, limit?: number): string {
    const absPath = this.resolveSafePath(projectRoot, relativePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${relativePath}`);
    }

    if (offset !== undefined || limit !== undefined) {
      const raw = fs.readFileSync(absPath, "utf-8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;
      const startLine = Math.max(1, offset ?? 1);
      const endLine = limit !== undefined ? Math.min(startLine + limit - 1, totalLines) : totalLines;
      const selected = allLines.slice(startLine - 1, endLine);
      const numbered = selected.map((line, i) => {
        const num = String(startLine + i).padStart(6, " ");
        return `${num}|${line}`;
      });
      const header = `[showing lines ${startLine}-${endLine} of ${totalLines} total]`;
      return `${header}\n${numbered.join("\n")}`;
    }

    const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_SIZE));
    const fd = fs.openSync(absPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let result = buf.subarray(0, bytesRead).toString("utf-8");
    if (stat.size > MAX_READ_SIZE) {
      result += `\n\n[... truncated, file is ${stat.size} bytes, showing first ${MAX_READ_SIZE} bytes]`;
    }
    return result;
  }

  editFile(projectRoot: string, relativePath: string, oldString: string, newString: string): string {
    const absPath = this.resolveSafePath(projectRoot, relativePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const content = fs.readFileSync(absPath, "utf-8");

    const count = content.split(oldString).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${relativePath}`);
    }
    if (count > 1) {
      throw new Error(`old_string found ${count} times in ${relativePath}, must be unique (exactly 1 occurrence)`);
    }

    const updated = content.replace(oldString, newString);
    fs.writeFileSync(absPath, updated, "utf-8");
    return absPath;
  }

  grepFiles(projectRoot: string, pattern: string, relativePath?: string, include?: string): string {
    const targetDir = relativePath && relativePath !== "."
      ? this.resolveSafePath(projectRoot, relativePath)
      : projectRoot;

    if (!fs.existsSync(targetDir)) {
      throw new Error(`Directory not found: ${relativePath ?? "."}`);
    }

    const args = ["-rn", "--color=never"];
    if (include) args.push(`--include=${include}`);
    args.push(pattern, targetDir);

    try {
      const output = execFileSync("grep", args, {
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
        encoding: "utf-8",
      });
      const lines = output.split("\n").map((line) =>
        line.replace(projectRoot + path.sep, "").replace(projectRoot, ""),
      );
      const result = lines.join("\n");
      if (result.length > 8000) {
        return result.slice(0, 8000) + `\n\n[... truncated, ${lines.length} matches total]`;
      }
      return result || "(no matches)";
    } catch (err: unknown) {
      const exitErr = err as { status?: number; stdout?: string };
      if (exitErr.status === 1) return "(no matches)";
      throw new Error(`grep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  listFiles(projectRoot: string, relativePath?: string, recursive?: boolean): string[] {
    const targetDir = relativePath && relativePath !== "."
      ? this.resolveSafePath(projectRoot, relativePath)
      : projectRoot;

    if (!fs.existsSync(targetDir)) {
      throw new Error(`Directory not found: ${relativePath ?? "."}`);
    }
    if (!fs.statSync(targetDir).isDirectory()) {
      throw new Error(`Path is not a directory: ${relativePath ?? "."}`);
    }

    const results: string[] = [];
    const walk = (dir: string, prefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === META_FILE) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          if (IGNORED_DIRS.has(entry.name)) continue;
          if (recursive) walk(path.join(dir, entry.name), rel);
        } else {
          results.push(rel);
        }
      }
    };
    walk(targetDir, "");
    return results;
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function sanitizeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

type CreateProjectInput = {
  id: string;
  name: string;
  source: CodeProjectSource;
  externalProjectId?: string;
};

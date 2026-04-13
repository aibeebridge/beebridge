import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  constructor(private readonly projectsRoot: string) {
    if (!fs.existsSync(projectsRoot)) {
      fs.mkdirSync(projectsRoot, { recursive: true });
    }
  }

  createDistrictProjectDir(districtId: string, title: string): string {
    const slug = sanitizeSlug(title);
    const shortId = districtId.replace(/^district-/, "").slice(0, 10);
    const dirName = slug ? `${slug}_${shortId}` : shortId;
    const projectPath = path.join(this.projectsRoot, dirName);
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }
    return projectPath;
  }

  createProjectDir(taskId: string, title: string): string {
    const slug = sanitizeSlug(title);
    const shortId = taskId.replace(/^task-/, "").slice(0, 10);
    const dirName = slug ? `${slug}_${shortId}` : shortId;
    const projectPath = path.join(this.projectsRoot, dirName);

    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }

    const metaPath = path.join(projectPath, META_FILE);
    if (!fs.existsSync(metaPath)) {
      const meta: ProjectMeta = { taskId, title, createdAt: new Date().toISOString() };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    }

    return projectPath;
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

function sanitizeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GLOBAL_DIR = path.join(os.homedir(), ".beebridge");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_DIR, "config.json");

interface GlobalConfig {
  workspacePath: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Subfolders under `{dataRoot}/workspace` used by WorkspaceStore, graph, chain, etc.
 * Created up-front so the tree exists before any save.
 */
const WORKSPACE_DATA_SUBDIRS = ["districts", "bridges", "jobs", "activity", "team", "projects"] as const;

export class WorkspaceConfig {
  private _workspacePath: string;

  constructor() {
    this._workspacePath = this.resolve();
    this.ensureDataLayout();
  }

  /**
   * Create `{dataRoot}/workspace` and standard children (districts, jobs, …).
   * Also ensures `{dataRoot}` exists. Safe after `setWorkspacePath`.
   */
  ensureDataLayout(): void {
    try {
      ensureDir(this.dataRoot);
      ensureDir(this.workspaceRoot);
      for (const sub of WORKSPACE_DATA_SUBDIRS) {
        ensureDir(path.join(this.workspaceRoot, sub));
      }
    } catch (e) {
      console.error("[WorkspaceConfig] ensureDataLayout failed:", e);
    }
  }

  get workspacePath(): string {
    return this._workspacePath;
  }

  /** Root for all beebridge data: {workspacePath}/.beebridge (or legacy .beebridge-data) */
  get dataRoot(): string {
    const legacy = path.join(this._workspacePath, ".beebridge-data");
    if (fs.existsSync(legacy)) return legacy;
    return path.join(this._workspacePath, ".beebridge");
  }

  /** Workspace data sub-root: {dataRoot}/workspace */
  get workspaceRoot(): string {
    return path.join(this.dataRoot, "workspace");
  }

  /** Root for code generation projects: {workspaceRoot}/projects */
  get projectsRoot(): string {
    return path.join(this.workspaceRoot, "projects");
  }

  getWorkspacePath(): string {
    return this._workspacePath;
  }

  setWorkspacePath(newPath: string): void {
    const resolved = path.resolve(newPath);
    if (this.isInsideGateway(resolved)) {
      throw new Error(
        `Workspace path must not be inside apps/gateway. Use the project root or another directory: ${resolved}`,
      );
    }
    if (!fs.existsSync(resolved)) {
      ensureDir(resolved);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    this._workspacePath = resolved;
    this.saveGlobal({ workspacePath: resolved });
    this.ensureDataLayout();
  }

  /** Summary for API / diagnostics */
  info(): { workspacePath: string; dataRoot: string; workspaceRoot: string; files: string[] } {
    const dataRoot = this.dataRoot;
    const files: string[] = [];
    try {
      if (fs.existsSync(dataRoot)) {
        const walk = (dir: string, prefix = "") => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else files.push(rel);
          }
        };
        walk(dataRoot);
      }
    } catch {
      // best-effort
    }
    return {
      workspacePath: this._workspacePath,
      dataRoot,
      workspaceRoot: this.workspaceRoot,
      files,
    };
  }

  private resolve(): string {
    if (process.env.BEEBRIDGE_WORKSPACE) {
      const envPath = path.resolve(process.env.BEEBRIDGE_WORKSPACE);
      ensureDir(envPath);
      return envPath;
    }

    const global = this.loadGlobal();
    if (global?.workspacePath) {
      const p = path.resolve(global.workspacePath);
      if (!this.isInsideGateway(p)) {
        if (!fs.existsSync(p)) ensureDir(p);
        return p;
      }
    }

    const projectRoot = this.findProjectRoot();

    // Legacy: if .beebridge-data exists at project root, use it
    const legacyDir = path.join(projectRoot, ".beebridge-data");
    if (fs.existsSync(legacyDir)) {
      return projectRoot;
    }

    return projectRoot;
  }

  /**
   * Walk up from this file (__dirname) to find the beebridge project root
   * (the directory containing package.json with workspaces).
   * Falls back to cwd if not found.
   */
  private findProjectRoot(): string {
    let dir = path.resolve(import.meta.dirname ?? process.cwd());
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.workspaces) return dir;
        } catch { /* continue */ }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  /** Reject paths that point inside apps/gateway (source tree). */
  private isInsideGateway(p: string): boolean {
    const normalized = p.replace(/\\/g, "/").toLowerCase();
    return normalized.includes("/apps/gateway");
  }

  private loadGlobal(): GlobalConfig | null {
    try {
      if (!fs.existsSync(GLOBAL_CONFIG_FILE)) return null;
      const raw = fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8");
      return JSON.parse(raw) as GlobalConfig;
    } catch {
      return null;
    }
  }

  private saveGlobal(config: GlobalConfig): void {
    try {
      ensureDir(GLOBAL_DIR);
      fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    } catch {
      // best-effort
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GLOBAL_DIR = path.join(os.homedir(), ".beebridge");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_DIR, "config.json");
const DEFAULT_WORKSPACE_DIR = path.join(GLOBAL_DIR, "workspace");
const LEGACY_HOME_DATA_ROOT = path.join(GLOBAL_DIR, ".beebridge");

interface GlobalConfig {
  workspacePath: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Beebridge app-state folders under `{workspacePath}/state`.
 * Legacy installs used nested data roots; those are migrated for home installs.
 */
const STATE_DATA_SUBDIRS = ["districts", "bridges", "jobs", "activity", "team"] as const;

export class WorkspaceConfig {
  private _workspacePath: string;

  constructor() {
    this._workspacePath = this.resolve();
    this.ensureDataLayout();
  }

  /**
   * Create app state and code-project folders. Safe after `setWorkspacePath`.
   */
  ensureDataLayout(): void {
    try {
      this.migrateLegacyHomeDataRoot();
      ensureDir(this._workspacePath);
      ensureDir(this.dataRoot);
      ensureDir(this.stateRoot);
      ensureDir(this.codeProjectsRoot);
      for (const sub of STATE_DATA_SUBDIRS) {
        ensureDir(path.join(this.stateRoot, sub));
      }
    } catch (e) {
      console.error("[WorkspaceConfig] ensureDataLayout failed:", e);
    }
  }

  get workspacePath(): string {
    return this._workspacePath;
  }

  /** Root for all beebridge data: the workspace path itself (or legacy .beebridge-data). */
  get dataRoot(): string {
    const legacy = path.join(this._workspacePath, ".beebridge-data");
    if (fs.existsSync(legacy)) return legacy;
    return this._workspacePath;
  }

  private get legacyWorkspaceRoot(): string {
    return path.join(this.dataRoot, "workspace");
  }

  /** App state sub-root for districts, jobs, bridges, activity, and team files. */
  get stateRoot(): string {
    return path.join(this.dataRoot, "state");
  }

  /** Root for code generation projects. */
  get codeProjectsRoot(): string {
    return path.join(this.dataRoot, "code-projects");
  }

  /** @deprecated Use `stateRoot`. Kept so existing WorkspaceStore callers do not need to change at once. */
  get workspaceRoot(): string {
    return this.stateRoot;
  }

  /** @deprecated Use `codeProjectsRoot`. */
  get projectsRoot(): string {
    return this.codeProjectsRoot;
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
  info(): {
    workspacePath: string;
    dataRoot: string;
    stateRoot: string;
    codeProjectsRoot: string;
    workspaceRoot: string;
    projectsRoot: string;
    legacyWorkspaceRoot?: string;
    files: string[];
  } {
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
      stateRoot: this.stateRoot,
      codeProjectsRoot: this.codeProjectsRoot,
      workspaceRoot: this.stateRoot,
      projectsRoot: this.codeProjectsRoot,
      ...(fs.existsSync(this.legacyWorkspaceRoot) ? { legacyWorkspaceRoot: this.legacyWorkspaceRoot } : {}),
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
        const workspacePath = this.isHomeInstallRoot(p) ? DEFAULT_WORKSPACE_DIR : p;
        if (!fs.existsSync(workspacePath)) ensureDir(workspacePath);
        if (workspacePath !== p) this.saveGlobal({ workspacePath });
        return workspacePath;
      }
    }

    const projectRoot = this.findProjectRoot();

    // Legacy: if .beebridge-data exists at project root, use it
    const legacyDir = path.join(projectRoot, ".beebridge-data");
    if (fs.existsSync(legacyDir)) {
      return projectRoot;
    }

    if (this.isHomeInstallRoot(projectRoot)) {
      ensureDir(DEFAULT_WORKSPACE_DIR);
      this.saveGlobal({ workspacePath: DEFAULT_WORKSPACE_DIR });
      return DEFAULT_WORKSPACE_DIR;
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

  private isHomeInstallRoot(p: string): boolean {
    return path.resolve(p) === path.resolve(GLOBAL_DIR);
  }

  private isDefaultWorkspacePath(p: string): boolean {
    return path.resolve(p) === path.resolve(DEFAULT_WORKSPACE_DIR);
  }

  private migrateLegacyHomeDataRoot(): void {
    if (!this.isDefaultWorkspacePath(this._workspacePath)) return;
    ensureDir(GLOBAL_DIR);
    for (const sourceRoot of [LEGACY_HOME_DATA_ROOT, path.join(DEFAULT_WORKSPACE_DIR, ".beebridge")]) {
      if (!fs.existsSync(sourceRoot)) continue;
      ensureDir(DEFAULT_WORKSPACE_DIR);
      for (const entry of fs.readdirSync(sourceRoot)) {
        const from = path.join(sourceRoot, entry);
        const to = path.join(DEFAULT_WORKSPACE_DIR, entry);
        if (!fs.existsSync(to)) fs.renameSync(from, to);
      }
      try {
        fs.rmdirSync(sourceRoot);
      } catch {
        // Leave non-empty legacy folders in place if any files could not be moved safely.
      }
    }
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

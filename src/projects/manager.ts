/**
 * @file projects/manager.ts
 * @description 專案管理 — CRUD + 切換 + 頻道綁定
 *
 * 每個專案存於 ~/.catclaw/workspace/data/projects/{projectId}/project.json
 * 專案記憶路徑：~/.catclaw/memory/projects/{projectId}/
 *
 * 帳號切換專案：更新 account.projects[0]（currentProject）
 * 頻道綁定：config.channels.{channelId}.boundProject（靜態設定）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface Project {
  projectId: string;
  displayName: string;
  description?: string;
  /** 專案記憶路徑（預設 ~/.catclaw/memory/projects/{projectId}） */
  memoryPath?: string;
  /** 專案自訂 tool 目錄（可選） */
  toolsDir?: string;
  /** 所屬帳號（空陣列 = 公開專案） */
  members: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 頻道綁定專案後的解析結果 */
export interface ProjectBinding {
  projectId: string;
  /** 專案工作目錄（CWD） */
  cwd: string;
  /** 專案記憶目錄 */
  memoryDir: string;
  /** 專案 CLAUDE.md 內容（若存在） */
  claudeMd?: string;
  /** 專案物件 */
  project: Project;
}

// ── ProjectManager ────────────────────────────────────────────────────────────

export class ProjectManager {
  private readonly projectsDir: string;
  private cache = new Map<string, Project>();

  constructor(private readonly dataDir: string) {
    this.projectsDir = join(dataDir, "projects");
  }

  init(): void {
    mkdirSync(this.projectsDir, { recursive: true });
    log.info(`[projects] 初始化 projectsDir=${this.projectsDir}`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  create(opts: {
    projectId: string;
    displayName: string;
    description?: string;
    createdBy: string;
    memoryPath?: string;
    toolsDir?: string;
  }): Project {
    if (this.exists(opts.projectId)) {
      throw new Error(`專案 ${opts.projectId} 已存在`);
    }

    // 驗證 projectId：英數字 + - _，3-40 字元
    if (!/^[a-zA-Z0-9_-]{2,40}$/.test(opts.projectId)) {
      throw new Error("projectId 只允許英數字、-、_，且需 2-40 個字元");
    }

    const now = new Date().toISOString();
    const project: Project = {
      projectId: opts.projectId,
      displayName: opts.displayName,
      description: opts.description,
      memoryPath: opts.memoryPath,
      toolsDir: opts.toolsDir,
      members: [opts.createdBy],
      createdBy: opts.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.save(project);
    log.info(`[projects] 建立專案 ${opts.projectId} by=${opts.createdBy}`);
    return project;
  }

  get(projectId: string): Project | null {
    if (this.cache.has(projectId)) return this.cache.get(projectId)!;

    const path = this.projectPath(projectId);
    if (!existsSync(path)) return null;

    try {
      const project = JSON.parse(readFileSync(path, "utf-8")) as Project;
      this.cache.set(projectId, project);
      return project;
    } catch (err) {
      log.warn(`[projects] 讀取 ${projectId} 失敗：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  update(projectId: string, patch: Partial<Omit<Project, "projectId" | "createdAt" | "createdBy">>): Project {
    const project = this.get(projectId);
    if (!project) throw new Error(`專案 ${projectId} 不存在`);

    const updated: Project = { ...project, ...patch, projectId, createdAt: project.createdAt, updatedAt: new Date().toISOString() };
    this.save(updated);
    return updated;
  }

  exists(projectId: string): boolean {
    return existsSync(this.projectPath(projectId));
  }

  list(): Project[] {
    let dirs: string[];
    try {
      dirs = readdirSync(this.projectsDir);
    } catch {
      return [];
    }

    const projects: Project[] = [];
    for (const dir of dirs) {
      const p = this.get(dir);
      if (p) projects.push(p);
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 列出帳號可見的專案（member 或 public） */
  listForAccount(accountId: string): Project[] {
    return this.list().filter(p => p.members.length === 0 || p.members.includes(accountId));
  }

  // ── 成員管理 ──────────────────────────────────────────────────────────────

  addMember(projectId: string, accountId: string): void {
    const project = this.get(projectId);
    if (!project) throw new Error(`專案 ${projectId} 不存在`);
    if (!project.members.includes(accountId)) {
      project.members = [...project.members, accountId];
      this.save(project);
    }
  }

  removeMember(projectId: string, accountId: string): void {
    const project = this.get(projectId);
    if (!project) throw new Error(`專案 ${projectId} 不存在`);
    project.members = project.members.filter(m => m !== accountId);
    this.save(project);
  }

  // ── 記憶路徑解析 ──────────────────────────────────────────────────────────

  /**
   * 取得專案記憶目錄路徑
   * 預設：~/.catclaw/memory/projects/{projectId}
   * 可由 project.memoryPath 覆寫
   */
  resolveMemoryDir(projectId: string, globalMemoryRoot: string): string {
    const project = this.get(projectId);
    if (project?.memoryPath) return project.memoryPath;
    return join(globalMemoryRoot, "projects", projectId);
  }

  /**
   * 解析專案綁定資訊：cwd、記憶路徑、專案 CLAUDE.md 內容。
   * 供頻道處理器在建立 agent-loop 前使用。
   */
  resolveBinding(projectId: string, globalMemoryRoot: string): ProjectBinding | null {
    const project = this.get(projectId);
    if (!project) return null;

    // cwd：以 toolsDir 的父目錄（若有）或 dataDir/projects/{id} 作為工作目錄
    const projectDir = join(this.projectsDir, projectId);
    const cwd = project.toolsDir ?? projectDir;

    // 記憶路徑
    const memoryDir = this.resolveMemoryDir(projectId, globalMemoryRoot);

    // 專案 CLAUDE.md
    let claudeMd: string | undefined;
    const claudeMdPath = join(cwd, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      try { claudeMd = readFileSync(claudeMdPath, "utf-8"); } catch { /* skip */ }
    }

    return { projectId, cwd, memoryDir, claudeMd, project };
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  private projectPath(projectId: string): string {
    return join(this.projectsDir, projectId, "project.json");
  }

  private save(project: Project): void {
    const dir = join(this.projectsDir, project.projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.projectPath(project.projectId), JSON.stringify(project, null, 2), "utf-8");
    this.cache.set(project.projectId, project);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _manager: ProjectManager | null = null;

export function initProjectManager(dataDir: string): ProjectManager {
  _manager = new ProjectManager(dataDir);
  _manager.init();
  return _manager;
}

export function getProjectManager(): ProjectManager {
  if (!_manager) throw new Error("[projects] 尚未初始化，請先呼叫 initProjectManager()");
  return _manager;
}

export function resetProjectManager(): void {
  _manager = null;
}

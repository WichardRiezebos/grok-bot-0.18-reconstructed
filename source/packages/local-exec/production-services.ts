import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

import type { SandboxRule } from "./sandbox-conversion.js";

const IGNORE_FILENAMES = [".cursorignore", ".gitignore"] as const;
const DEFAULT_SANDBOX_POLICY: SandboxRule = { type: "workspace_readwrite" };

function posixRelative(root: string, filePath: string): string | null {
  const rel = relative(root, filePath);
  if (rel.startsWith(`..${sep}`) || rel === "..") return null;
  return rel.split(sep).join("/");
}

function loadIgnoreForRoot(root: string): Ignore {
  const matcher = ignore();
  for (const name of IGNORE_FILENAMES) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    try {
      matcher.add(readFileSync(path, "utf8"));
    } catch {}
  }
  return matcher;
}

export class ProductionIgnoreService {
  private readonly cache = new Map<string, Ignore>();

  constructor(private readonly workspaceRoot: string) {}

  private matcherFor(filePath: string): { root: string; matcher: Ignore } | null {
    let current = dirname(resolve(filePath));
    const stop = resolve(this.workspaceRoot);
    while (current.startsWith(stop)) {
      const cached = this.cache.get(current);
      if (cached != null) return { root: current, matcher: cached };
      if (IGNORE_FILENAMES.some(name => existsSync(resolve(current, name)))) {
        const matcher = loadIgnoreForRoot(current);
        this.cache.set(current, matcher);
        return { root: current, matcher };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return existsSync(stop) ? { root: stop, matcher: this.cache.get(stop) ?? loadIgnoreForRoot(stop) } : null;
  }

  private ignored(filePath: string): boolean {
    const found = this.matcherFor(filePath);
    if (found == null) return false;
    const rel = posixRelative(found.root, filePath);
    if (rel == null || rel.length === 0) return false;
    return found.matcher.ignores(rel);
  }

  isCursorIgnored(path: string): Promise<boolean> { return Promise.resolve(this.ignored(path)); }
  isGitIgnored(path: string): Promise<boolean> { return Promise.resolve(this.ignored(path)); }
  isIgnoredByAny(path: string): Promise<boolean> { return Promise.resolve(this.ignored(path)); }
  listCursorIgnoreFilesByRoot(root: string): Promise<string[]> {
    const path = resolve(root, ".cursorignore");
    return Promise.resolve(existsSync(path) ? [path] : []);
  }
  isRepoBlocked(_path: string): Promise<boolean> { return Promise.resolve(false); }
  getCursorIgnoreMapping(): Promise<Record<string, never>> { return Promise.resolve({}); }
  getGitIgnoreMapping(): Promise<Record<string, never>> { return Promise.resolve({}); }
  getRepoBlockExcludeGlobs(_root: string): Promise<never[]> { return Promise.resolve([]); }
}

export class ProductionPermissionsService {
  constructor(private readonly ignoreService: ProductionIgnoreService) {}

  shouldBlockRead(path: string): Promise<boolean> {
    return this.ignoreService.isIgnoredByAny(path);
  }
  shouldBlockWrite(_ctx: unknown, path: string, _newContents: string): Promise<boolean> {
    return this.ignoreService.isIgnoredByAny(path);
  }
  shouldBlockShellCommand(
    _ctx: unknown,
    _command: string,
    _options: unknown,
    requestedPolicy?: SandboxRule,
  ): Promise<{ kind: "allow"; policy: SandboxRule }> {
    return Promise.resolve({ kind: "allow", policy: requestedPolicy ?? DEFAULT_SANDBOX_POLICY });
  }
  shouldEnforceShellInvariantBlocks(): Promise<{ kind: "allow" }> {
    return Promise.resolve({ kind: "allow" });
  }
  isShellCommandFullyAllowlisted(): Promise<boolean> { return Promise.resolve(false); }
  shouldBlockMcp(): Promise<boolean> { return Promise.resolve(false); }
  isMcpFullyAllowlisted(): Promise<boolean> { return Promise.resolve(false); }
  isWebFetchFullyAllowlisted(): Promise<boolean> { return Promise.resolve(false); }
  addToAllowList(): Promise<void> { return Promise.resolve(); }
  addToDenyList(): Promise<void> { return Promise.resolve(); }
}

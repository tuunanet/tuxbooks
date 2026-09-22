import path from "node:path";

/**
 * Containment rule for the app-data deletion paths (data-management spec):
 * a target may be removed only when it resolves inside its owning root.
 * A lexical check rejects a target outside the root before any fs call, and
 * a realpath check rejects a symlink that points elsewhere. Kept in one place
 * so the cache clear and the reset share a single security invariant.
 */

/** The one fs call containment needs; callers inject their own surface. */
export interface ContainmentFs {
  realpathSync(target: string): string;
}

/**
 * Whether `target` resolves inside `root` once symlinks are resolved. A
 * missing target, or one whose real path escapes the real root, is refused.
 */
export function isContained(fs: ContainmentFs, root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) return false;
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(resolvedTarget);
    return realTarget.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

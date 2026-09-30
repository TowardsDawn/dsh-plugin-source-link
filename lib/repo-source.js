/**
 * 纯函数层：从 profile 依赖 spec、包清单（package.json）与本地 git 配置中
 * 推断一个插件包的仓库来源。全部只读，不做任何写操作。
 *
 * host 半（../index.js）与离线验证脚本共用这一层，因此这里不依赖 cordis，
 * 只依赖 node 内建模块。
 *
 * @module dsh-plugin-source-link/repo-source
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** 单个来源字符串的长度上限，挡住畸形清单。 */
const MAX_VALUE = 2048;

/**
 * 校验并归一化一个包名。
 *
 * 只接受 npm 包名形态（可带 scope），因此结果可以安全地拼进 node_modules
 * 路径 —— 路径分隔符、`..`、协议前缀一律判为非法。
 *
 * @param value - 待校验的值。
 * @returns 归一化后的包名，或 undefined。
 */
export function parsePackageName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name === "" || name.length > 256) return undefined;
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) return undefined;
  return name;
}

/**
 * 一个包名在 profile 里的安装目录。
 * @param profileDir - profile 目录的绝对路径。
 * @param packageName - 已由 {@link parsePackageName} 校验的包名。
 * @returns `node_modules` 下的绝对路径。
 */
export function modulePathOf(profileDir, packageName) {
  return join(profileDir, "node_modules", ...packageName.split("/"));
}

/** 去掉 Git URL 的 `.git` 后缀与尾部斜杠。 */
function trimGitSuffix(value) {
  return value.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * 把一个依赖 spec / 清单字段里的仓库写法归一化成 https 链接。
 *
 * 覆盖：`github:owner/repo`、`git+https://`、`git+ssh://`、
 * `git@host:owner/repo.git`（scp 形态）、裸 `owner/repo`。
 * `javascript:` / `data:` / `file:` 等非 Web 协议一律拒绝，避免把不可信清单
 * 里的字符串直接变成可点击链接。
 *
 * @param value - 原始字符串。
 * @returns `https://…` 链接，或 undefined。
 */
export function normalizeRepoUrl(value) {
  if (typeof value !== "string") return undefined;
  let raw = value.trim();
  if (raw === "" || raw.length > MAX_VALUE) return undefined;
  if (/^(javascript|data|vbscript|file):/i.test(raw)) return undefined;

  raw = raw.replace(/^git\+/i, "").replace(/[#?].*$/, "");
  if (raw === "") return undefined;

  if (/^github:/i.test(raw)) {
    const rest = raw.slice("github:".length).replace(/^\/+/, "");
    return rest === "" ? undefined : trimGitSuffix(`https://github.com/${rest}`);
  }

  const scheme = /^(?:git\+ssh|git\+https?|ssh|git|https?):\/\/(.+)$/i.exec(raw);
  if (scheme !== null) {
    const rest = scheme[1].replace(/^[^@/]+@/, "");
    const parts = /^([^/:]+)(?::\d+)?\/(.+)$/.exec(rest);
    if (parts === null) return undefined;
    const path = parts[2].replace(/^\/+/, "");
    return path === "" ? undefined : trimGitSuffix(`https://${parts[1]}/${path}`);
  }

  const scp = /^[^@/\s]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):([^\s]+)$/.exec(raw);
  if (scp !== null) return trimGitSuffix(`https://${scp[1]}/${scp[2]}`);

  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw);
  if (bare !== null) return `https://github.com/${bare[1]}/${bare[2]}`;

  return undefined;
}

/**
 * profile 里的依赖 spec 直接给出的来源。
 *
 * - `file:` / `link:` → 本地路径（相对 spec 以 profile 目录为基准展开）
 * - `github:` / git / https → 仓库链接
 * - 其余（npm 版本区间、`npm:` 别名、workspace:）→ 空，留给清单与 git 远端
 *
 * @param profileDir - profile 目录。
 * @param spec - `package.json` 里记录的依赖 spec。
 * @returns `{ url? , path? }`。
 */
export function specToSource(profileDir, spec) {
  if (typeof spec !== "string") return {};
  const value = spec.trim();
  if (value === "") return {};

  const local = /^(?:file|link):(.+)$/i.exec(value);
  if (local !== null) {
    const target = local[1].trim();
    if (target === "") return {};
    return { path: isAbsolute(target) ? target : resolve(profileDir, target) };
  }

  if (/^(?:github:|git\+|git:|ssh:|https?:)/i.test(value)) {
    const url = normalizeRepoUrl(value);
    return url === undefined ? {} : { url };
  }

  return {};
}

/**
 * 读取一个包目录的清单，取 repository / homepage / bugs.url 里第一个可用链接。
 * @param dir - 包目录（通常是 node_modules 下的真实目录）。
 * @returns `{ url? , version? }`。
 */
export function readManifestSource(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const version = typeof manifest.version === "string" ? manifest.version : undefined;
    const candidates = [
      manifest.repository,
      manifest.homepage,
      manifest.bugs === undefined || manifest.bugs === null ? undefined : manifest.bugs.url,
    ];
    for (const candidate of candidates) {
      const value =
        typeof candidate === "string"
          ? candidate
          : candidate !== null && typeof candidate === "object"
            ? candidate.url
            : undefined;
      const url = normalizeRepoUrl(value);
      if (url !== undefined) return { url, version };
    }
    return { version };
  } catch {
    return {};
  }
}

/**
 * 本地仓库目录的 origin 远端链接。
 *
 * 同时支持普通仓库（`.git` 是目录）与 git worktree / submodule（`.git` 是
 * 指向真实 gitdir 的文件）。
 *
 * @param dir - 疑似仓库根目录。
 * @returns https 链接，或 undefined。
 */
export function gitOriginUrl(dir) {
  try {
    let gitDir = join(dir, ".git");
    const stats = statSync(gitDir);
    if (stats.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/im.exec(readFileSync(gitDir, "utf8"));
      if (pointer === null) return undefined;
      const target = pointer[1].trim();
      gitDir = isAbsolute(target) ? target : resolve(dir, target);
    }
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const section = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(config);
    if (section === null) return undefined;
    const urlLine = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
    return urlLine === null ? undefined : normalizeRepoUrl(urlLine[1].trim());
  } catch {
    return undefined;
  }
}

/**
 * 目录的真实路径（解开 pnpm / npm link 的符号链接）。
 * @param dir - 候选目录。
 * @returns 真实目录的绝对路径，或 undefined（不存在 / 不是目录）。
 */
export function realDirectoryOf(dir) {
  try {
    return statSync(dir).isDirectory() ? realpathSync(dir) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从 profile 的 `package.json` 里读一个包的依赖 spec。
 * @param profileDir - profile 目录。
 * @param packageName - 包名。
 * @returns spec 字符串，或 undefined。
 */
export function readProfileDependency(profileDir, packageName) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
    const groups = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ];
    for (const group of groups) {
      if (group !== null && typeof group === "object" && typeof group[packageName] === "string") {
        return group[packageName];
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * profile 里所有依赖的 spec（四个分组合并，后面的分组不覆盖前面的）。
 * @param profileDir - profile 目录。
 * @returns `{ [packageName]: spec }`。
 */
export function readProfileDependencies(profileDir) {
  const result = {};
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
    const groups = [
      manifest.peerDependencies,
      manifest.optionalDependencies,
      manifest.devDependencies,
      manifest.dependencies,
    ];
    for (const group of groups) {
      if (group === null || typeof group !== "object") continue;
      for (const [key, value] of Object.entries(group)) {
        if (typeof value === "string") result[key] = value;
      }
    }
  } catch {
    // 读不到 profile 清单时按“没有依赖”处理，调用方会退回逐包探测。
  }
  return result;
}

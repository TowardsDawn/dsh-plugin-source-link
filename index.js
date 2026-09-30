/**
 * dsh-plugin-source-link — host 半。
 *
 * 为官方插件面板（`plugins` 面板）的每个详情页提供该插件的「来源」信息：
 *
 * 1. profile `package.json` 里的依赖 spec（`github:` / `git+…` / `file:` / `link:`）；
 * 2. `node_modules/<pkg>/package.json` 的 `repository` / `homepage`；
 * 3. 本地源码目录 `.git/config` 的 `origin` 远端（覆盖 pnpm link / 本地开发插件）。
 *
 * 同时提供一个受 loopback 保护的写入端点，把用户手动填写的 URL / 路径持久化到
 * profile 目录下的 `plugin-source-links.json`。插件自身不改动任何被管理的插件文件。
 *
 * 路由（均要求 loopback 来源）：
 * - `GET  /api/plugin-source-link/one?name=<pkg>`  解析单个包
 * - `GET  /api/plugin-source-link/list`             profile 全部依赖的解析结果
 * - `POST /api/plugin-source-link/set`              `{ name, url?, path? }` 保存手动值
 * - `POST /api/plugin-source-link/clear`            `{ name }` 清除手动值
 *
 * @module dsh-plugin-source-link
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  gitOriginUrl,
  modulePathOf,
  normalizeRepoUrl,
  parsePackageName,
  readManifestSource,
  readProfileDependencies,
  readProfileDependency,
  realDirectoryOf,
  specToSource,
} from "./lib/repo-source.js";

/** cordis 插件名，与 cordis.patch.yml 的 insert id 一致。 */
export const name = "plugin-source-link";
/** 需要 Web 服务器接缝来注册路由。 */
export const inject = ["webServer"];

/** 路由前缀（host 侧带前导斜杠）。 */
const PREFIX = "/api/plugin-source-link";
/** 手动值存储文件名，位于 profile 目录下。 */
const STORE_FILE = "plugin-source-links.json";
/** 请求体与手动路径字段的长度上限。 */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 1024;

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

/** IPv4 127/8 判定。 */
function isIPv4Loopback(value) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** socket 远端地址是否属于 loopback 范围。 */
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/**
 * 请求是否来自本机浏览器。
 *
 * 远端地址与 Host 头都必须落在 loopback 上：只信 socket 会让 DNS rebinding
 * 把一个外部页面变成对 `/api` 的同源请求，因此 Host 不是 loopback 名字时直接拒绝。
 */
function isLoopbackRequest(req) {
  const socket = req.socket;
  if (socket === undefined || !isLoopbackAddress(socket.remoteAddress)) return false;
  const host = req.headers === undefined ? undefined : req.headers.host;
  if (typeof host !== "string" || host === "") return true;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "::1") return true;
  return isIPv4Loopback(hostname);
}

/** 把 handler 包进 loopback 栅栏与 JSON 错误上报。 */
function guard(handler) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** DSH 数据目录（`DSH_HOME` 优先，否则 `~/.dsh`）。 */
function dshHomeDir() {
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  return fromEnv !== "" ? fromEnv : join(homedir(), ".dsh");
}

/**
 * 解析当前启动的 profile 目录。
 *
 * 优先 Host 发布的 `profileContext`（它拿到的就是加载器实际使用的目录），
 * 其次 `--profile` 参数与 `DSH_PROFILE`，最后回退到 `web` profile。
 *
 * @param ctx - host 插件上下文。
 * @returns profile 目录的绝对路径，或 undefined。
 */
function resolveProfileDir(ctx) {
  let published;
  try {
    published = ctx.get("profileContext");
  } catch {
    published = undefined;
  }
  if (published !== null && published !== undefined && typeof published === "object") {
    const dir = typeof published.dir === "string" ? published.dir.trim() : "";
    if (dir !== "" && isAbsolute(dir)) return dir;
    const publishedName = typeof published.name === "string" ? published.name.trim() : "";
    if (publishedName !== "") return join(dshHomeDir(), "profiles", publishedName);
  }

  const argv = Array.isArray(process.argv) ? process.argv : [];
  const flagIndex = argv.indexOf("--profile");
  const flagValue = flagIndex === -1 ? "" : String(argv[flagIndex + 1] ?? "").trim();
  if (flagValue !== "") return join(dshHomeDir(), "profiles", flagValue);

  const envProfile = typeof process.env.DSH_PROFILE === "string" ? process.env.DSH_PROFILE.trim() : "";
  if (envProfile !== "") return join(dshHomeDir(), "profiles", envProfile);

  const webProfile = join(dshHomeDir(), "profiles", "web");
  return existsSync(webProfile) ? webProfile : undefined;
}

/** 读取手动值存储；坏数据按空处理。 */
async function readStore(profileDir) {
  if (profileDir === undefined) return {};
  try {
    const text = await readFile(join(profileDir, STORE_FILE), "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [key, value] of Object.entries(parsed)) {
      const packageName = parsePackageName(key);
      if (packageName === undefined) continue;
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = {};
      if (typeof value.url === "string" && value.url.trim() !== "") {
        const url = normalizeRepoUrl(value.url);
        if (url !== undefined) entry.url = url;
      }
      if (typeof value.path === "string" && value.path.trim() !== "") {
        entry.path = value.path.trim().slice(0, MAX_TEXT);
      }
      if (Object.keys(entry).length > 0) clean[packageName] = entry;
    }
    return clean;
  } catch {
    return {};
  }
}

/** 写回手动值存储。 */
async function writeStore(profileDir, data) {
  await writeFile(join(profileDir, STORE_FILE), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** 读一个小型 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 解析一个包的来源：自动推断 + 手动覆盖。
 *
 * @param profileDir - profile 目录。
 * @param packageName - 已校验的包名。
 * @param manual - 该包的手动值（若有）。
 * @returns 面板详情页需要的完整条目。
 */
function resolveEntry(profileDir, packageName, manual) {
  const spec = readProfileDependency(profileDir, packageName);
  const fromSpec = specToSource(profileDir, spec);

  let url = fromSpec.url;
  let source = url === undefined ? undefined : "profile-dependency";
  let localPath = fromSpec.path;
  if (localPath !== undefined && source === undefined) source = "profile-dependency";

  let version;
  const installedDir = modulePathOf(profileDir, packageName);
  const realDir = realDirectoryOf(installedDir);

  // spec 里的相对路径可能已经失效（插件被移动、profile 被复制）。能解析到真实
  // 目录时就采用真实路径；解析不到则退回 node_modules 里的实际安装位置，
  // 避免面板显示一个复制后打不开的路径。
  if (localPath !== undefined) {
    const realSpecPath = realDirectoryOf(localPath);
    if (realSpecPath !== undefined) localPath = realSpecPath;
    else if (realDir !== undefined) localPath = realDir;
  }

  if (realDir !== undefined) {
    const manifest = readManifestSource(realDir);
    if (typeof manifest.version === "string") version = manifest.version;
    if (url === undefined && manifest.url !== undefined) {
      url = manifest.url;
      source = "package.json";
    }
    if (url === undefined) {
      const origin = gitOriginUrl(realDir);
      if (origin !== undefined) {
        url = origin;
        source = "git-remote";
      }
    }
    if (localPath === undefined) localPath = realDir;
  }

  const auto = {
    url: url === undefined ? null : url,
    path: localPath === undefined ? null : localPath,
    source: source === undefined ? "none" : source,
  };

  const manualUrl = manual !== null && manual !== undefined && typeof manual.url === "string" ? manual.url : null;
  const manualPath = manual !== null && manual !== undefined && typeof manual.path === "string" ? manual.path : null;
  const manualActive = manualUrl !== null || manualPath !== null;

  return {
    name: packageName,
    version: version === undefined ? null : version,
    spec: typeof spec === "string" ? spec : null,
    url: manualUrl !== null ? manualUrl : auto.url,
    path: manualPath !== null ? manualPath : auto.path,
    resolvedFrom: manualActive ? "manual" : auto.source,
    manual: manualActive ? { url: manualUrl, path: manualPath } : null,
    auto,
    installed: realDir !== undefined,
    profileDir,
  };
}

/** `GET …/one?name=<pkg>`：解析单个包。 */
async function oneHandler(ctx, req, res) {
  const requestUrl = new URL(typeof req.url === "string" ? req.url : PREFIX, "http://localhost");
  const packageName = parsePackageName(requestUrl.searchParams.get("name"));
  if (packageName === undefined) {
    writeJson(res, 400, { ok: false, error: "invalid package name" });
    return;
  }
  const profileDir = resolveProfileDir(ctx);
  if (profileDir === undefined) {
    writeJson(res, 500, { ok: false, error: "cannot determine the boot profile directory" });
    return;
  }
  const store = await readStore(profileDir);
  writeJson(res, 200, { ok: true, entry: resolveEntry(profileDir, packageName, store[packageName]) });
}

/** `GET …/list`：profile 全部依赖的解析结果。 */
async function listHandler(ctx, req, res) {
  const profileDir = resolveProfileDir(ctx);
  if (profileDir === undefined) {
    writeJson(res, 500, { ok: false, error: "cannot determine the boot profile directory" });
    return;
  }
  const store = await readStore(profileDir);
  const dependencies = readProfileDependencies(profileDir);
  const names = new Set([...Object.keys(dependencies), ...Object.keys(store)]);
  const entries = [];
  for (const packageName of names) {
    entries.push(resolveEntry(profileDir, packageName, store[packageName]));
  }
  writeJson(res, 200, { ok: true, profileDir, entries });
}

/** `POST …/set`：保存（或覆盖）一个包的手动值。 */
async function setHandler(ctx, req, res) {
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, { ok: false, error: "invalid JSON body" });
    return;
  }
  const packageName = parsePackageName(body.name);
  if (packageName === undefined) {
    writeJson(res, 400, { ok: false, error: "invalid package name" });
    return;
  }
  const profileDir = resolveProfileDir(ctx);
  if (profileDir === undefined) {
    writeJson(res, 500, { ok: false, error: "cannot determine the boot profile directory" });
    return;
  }

  const urlRaw = typeof body.url === "string" ? body.url.trim() : "";
  const pathRaw = typeof body.path === "string" ? body.path.trim() : "";
  const entry = {};
  if (urlRaw !== "") {
    const url = normalizeRepoUrl(urlRaw);
    if (url === undefined) {
      writeJson(res, 400, { ok: false, error: "URL 需要是 http(s) 链接或 git 地址" });
      return;
    }
    entry.url = url;
  }
  if (pathRaw !== "") entry.path = pathRaw.slice(0, MAX_TEXT);

  const store = await readStore(profileDir);
  if (Object.keys(entry).length === 0) delete store[packageName];
  else store[packageName] = entry;
  await writeStore(profileDir, store);
  writeJson(res, 200, { ok: true, entry: resolveEntry(profileDir, packageName, store[packageName]) });
}

/** `POST …/clear`：清除一个包的手动值，回到自动推断结果。 */
async function clearHandler(ctx, req, res) {
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, { ok: false, error: "invalid JSON body" });
    return;
  }
  const packageName = parsePackageName(body.name);
  if (packageName === undefined) {
    writeJson(res, 400, { ok: false, error: "invalid package name" });
    return;
  }
  const profileDir = resolveProfileDir(ctx);
  if (profileDir === undefined) {
    writeJson(res, 500, { ok: false, error: "cannot determine the boot profile directory" });
    return;
  }
  const store = await readStore(profileDir);
  delete store[packageName];
  await writeStore(profileDir, store);
  writeJson(res, 200, { ok: true, entry: resolveEntry(profileDir, packageName, undefined) });
}

/** 组装全部路由。 */
function makeRoutes(ctx) {
  return [
    { kind: "exact", path: `${PREFIX}/one`, handler: guard((req, res) => oneHandler(ctx, req, res)) },
    { kind: "exact", path: `${PREFIX}/list`, handler: guard((req, res) => listHandler(ctx, req, res)) },
    { kind: "exact", path: `${PREFIX}/set`, handler: guard((req, res) => setHandler(ctx, req, res)) },
    { kind: "exact", path: `${PREFIX}/clear`, handler: guard((req, res) => clearHandler(ctx, req, res)) },
  ];
}

/** 挂载 host 半：注册路由，随 fiber 卸载一起释放。 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 单条路由释放失败不影响其余路由。
        }
      }
    };
  }, "plugin-source-link: routes");
}

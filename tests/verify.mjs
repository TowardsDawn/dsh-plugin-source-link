/**
 * dsh-plugin-source-link 的离线自检（不依赖 DSH 运行时）。
 *
 *   node tests/verify.mjs
 *
 * 1. 纯函数层：URL 归一化 / spec 解析 / 包名校验；
 * 2. host 半：用假 ctx + 假 req/res 直接驱动 4 条路由，在临时 DSH_HOME 上
 *    验证自动推断（github spec / package.json / .git 远端 / file+link）、
 *    手动值读写与 loopback 栅栏。
 *
 * 全部 fixtures 建在工作区内、跑完即删；不会碰真实的 profile。
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = join(PLUGIN_ROOT, ".verify-tmp");
const DSH_HOME = join(TMP, "dsh-home");
const PROFILE_DIR = join(DSH_HOME, "profiles", "web-test");

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`)
  );
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------- fixtures ----------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(PROFILE_DIR, "node_modules"), { recursive: true });

writeJson(join(PROFILE_DIR, "package.json"), {
  name: "dsh-profile-web-test",
  private: true,
  dependencies: {
    "pkg-github": "github:acme/pkg-github",
    "pkg-gitssh": "git+ssh://git@gitlab.com/acme/pkg-gitssh.git",
    "pkg-file": "file:../../plugins/pkg-file",
    "pkg-repo": "^1.2.3",
    "pkg-local-git": "^0.1.0",
    "pkg-nothing": "^9.9.9",
  },
});

mkdirSync(join(PROFILE_DIR, "node_modules", "pkg-repo"), { recursive: true });
writeJson(join(PROFILE_DIR, "node_modules", "pkg-repo", "package.json"), {
  name: "pkg-repo",
  version: "1.2.3",
  repository: { type: "git", url: "git+https://github.com/acme/pkg-repo.git" },
});

const localGitDir = join(PROFILE_DIR, "node_modules", "pkg-local-git");
mkdirSync(join(localGitDir, ".git"), { recursive: true });
writeJson(join(localGitDir, "package.json"), { name: "pkg-local-git", version: "0.1.0" });
writeFileSync(
  join(localGitDir, ".git", "config"),
  '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/local-git.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  "utf8"
);

const fileSource = join(TMP, "plugins", "pkg-file");
mkdirSync(join(fileSource, ".git"), { recursive: true });
writeJson(join(fileSource, "package.json"), { name: "pkg-file", version: "0.0.1" });
writeFileSync(join(fileSource, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/pkg-file\n', "utf8");
symlinkSync(fileSource, join(PROFILE_DIR, "node_modules", "pkg-file"), "junction");

process.env.DSH_HOME = DSH_HOME;
process.env.DSH_PROFILE = "web-test";

// ---------- 纯函数层 ----------
const lib = await import(pathToFileURL(join(PLUGIN_ROOT, "lib", "repo-source.js")).href);

check("github: spec", lib.normalizeRepoUrl("github:acme/repo"), "https://github.com/acme/repo");
check("github: spec 带 ref", lib.normalizeRepoUrl("github:acme/repo#v1.2"), "https://github.com/acme/repo");
check("git+https", lib.normalizeRepoUrl("git+https://github.com/acme/repo.git"), "https://github.com/acme/repo");
check("git+ssh", lib.normalizeRepoUrl("git+ssh://git@github.com/acme/repo.git"), "https://github.com/acme/repo");
check("ssh 带端口", lib.normalizeRepoUrl("ssh://git@github.com:22/acme/repo.git"), "https://github.com/acme/repo");
check("scp 形态", lib.normalizeRepoUrl("git@github.com:acme/repo.git"), "https://github.com/acme/repo");
check("裸 owner/repo", lib.normalizeRepoUrl("acme/repo"), "https://github.com/acme/repo");
check("普通 https", lib.normalizeRepoUrl("https://example.com/acme/repo"), "https://example.com/acme/repo");
check("拒绝 javascript:", lib.normalizeRepoUrl("javascript:alert(1)"), undefined);
check("拒绝 file:", lib.normalizeRepoUrl("file:///etc/passwd"), undefined);
check("非法包名", lib.parsePackageName("../../etc"), undefined);
check("合法 scoped 包名", lib.parsePackageName("@scope/pkg"), "@scope/pkg");
check("file: 解析为绝对路径", lib.specToSource("D:/prof", "file:../../plugins/x").path, "D:\\plugins\\x");
check("github: 解析为链接", lib.specToSource("D:/prof", "github:acme/x").url, "https://github.com/acme/x");
check("版本区间不产出来源", lib.specToSource("D:/prof", "^1.0.0"), {});

// ---------- host 半 ----------
const host = await import(pathToFileURL(join(PLUGIN_ROOT, "index.js")).href);
check("host 导出的插件名", host.name, "plugin-source-link");
check("host inject", host.inject, ["webServer"]);

const routes = new Map();
const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};
host.apply(ctx);
check("注册了 4 条路由", [...routes.keys()].sort(), [
  "/api/plugin-source-link/clear",
  "/api/plugin-source-link/list",
  "/api/plugin-source-link/one",
  "/api/plugin-source-link/set",
]);

function makeReq({ url, method = "GET", body, remoteAddress = "127.0.0.1", host: hostHeader = "127.0.0.1:3080" }) {
  const req = { url, method, headers: { host: hostHeader }, socket: { remoteAddress } };
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
  };
  return req;
}

function makeRes() {
  return {
    status: 0,
    payload: "",
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      this.payload = chunk === undefined ? "" : String(chunk);
    },
    destroy() {},
  };
}

async function call(path, options) {
  const handler = routes.get(path);
  const res = makeRes();
  await handler(makeReq({ url: path + (options && options.query ? options.query : ""), ...options }), res);
  return { status: res.status, body: res.payload === "" ? null : JSON.parse(res.payload) };
}

const one = await call("/api/plugin-source-link/one", { query: "?name=pkg-github" });
check("github: 依赖 → URL", one.body.entry.url, "https://github.com/acme/pkg-github");
check("github: 依赖来源标记", one.body.entry.resolvedFrom, "profile-dependency");
check("github: 依赖 spec 回显", one.body.entry.spec, "github:acme/pkg-github");

const sshEntry = await call("/api/plugin-source-link/one", { query: "?name=pkg-gitssh" });
check("git+ssh 依赖 → URL", sshEntry.body.entry.url, "https://gitlab.com/acme/pkg-gitssh");

const repoEntry = await call("/api/plugin-source-link/one", { query: "?name=pkg-repo" });
check("package.json repository → URL", repoEntry.body.entry.url, "https://github.com/acme/pkg-repo");
check("package.json 来源标记", repoEntry.body.entry.resolvedFrom, "package.json");
check("版本读取", repoEntry.body.entry.version, "1.2.3");

const localGitEntry = await call("/api/plugin-source-link/one", { query: "?name=pkg-local-git" });
check("本地 .git/config → URL", localGitEntry.body.entry.url, "https://github.com/acme/local-git");
check("本地 git 来源标记", localGitEntry.body.entry.resolvedFrom, "git-remote");

const fileEntry = await call("/api/plugin-source-link/one", { query: "?name=pkg-file" });
check("file: spec 路径失效时回落真实安装目录", fileEntry.body.entry.path, fileSource.replace(/\//g, "\\"));
check("file: 依赖走本地 git 远端拿 URL", fileEntry.body.entry.url, "https://github.com/acme/pkg-file");

const nothingEntry = await call("/api/plugin-source-link/one", { query: "?name=pkg-nothing" });
check("无任何来源 → url 为 null（前端显示输入框）", nothingEntry.body.entry.url, null);
check("无任何来源 → source=none", nothingEntry.body.entry.auto.source, "none");

const badName = await call("/api/plugin-source-link/one", { query: "?name=..%2F..%2Fetc" });
check("非法包名 → 400", badName.status, 400);

const setResult = await call("/api/plugin-source-link/set", {
  method: "POST",
  body: { name: "pkg-nothing", url: "git@github.com:me/manual.git", path: "D:\\src\\manual" },
});
check("保存手动值 → 200", setResult.status, 200);
check("手动 URL 被归一化", setResult.body.entry.url, "https://github.com/me/manual");
check("手动路径", setResult.body.entry.path, "D:\\src\\manual");
check("手动标记", setResult.body.entry.resolvedFrom, "manual");

const afterSet = await call("/api/plugin-source-link/one", { query: "?name=pkg-nothing" });
check("手动值持久化到磁盘", afterSet.body.entry.url, "https://github.com/me/manual");

const badUrl = await call("/api/plugin-source-link/set", {
  method: "POST",
  body: { name: "pkg-nothing", url: "javascript:alert(1)" },
});
check("危险 URL → 400", badUrl.status, 400);

const cleared = await call("/api/plugin-source-link/clear", { method: "POST", body: { name: "pkg-nothing" } });
check("清除手动值 → 回到自动结果", cleared.body.entry.url, null);
check("清除后 manual 为空", cleared.body.entry.manual, null);

const remote = await call("/api/plugin-source-link/one", {
  query: "?name=pkg-github",
  remoteAddress: "192.168.1.50",
});
check("非 loopback 来源 → 403", remote.status, 403);

const rebound = await call("/api/plugin-source-link/one", {
  query: "?name=pkg-github",
  remoteAddress: "127.0.0.1",
  host: "evil.example.com",
});
check("Host 头非 loopback → 403（防 DNS rebinding）", rebound.status, 403);

const listResult = await call("/api/plugin-source-link/list");
check("list 覆盖全部 profile 依赖", listResult.body.entries.length, 6);

rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

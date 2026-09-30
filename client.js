(() => {
  try {
    /*
     * dsh-plugin-source-link — browser 半。
     *
     * 通过官方插件面板声明的 `plugins.detail.section` 席位，在每个插件详情页
     * （组合包页 / 行页 / 官方插件页）底部渲染一个「插件来源」区块：
     * 仓库 URL 渲染为超链接，本地路径渲染为可复制文本；
     * 数据目录里提取不到时提供一个输入框，让用户自己填写并保存。
     *
     * 数据来自 host 半的 `/api/plugin-source-link/*`（仅本机浏览器可用）。
     */
    window.__ModuleLoader__.load({
      id: "dsh-plugin-source-link",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        var h = react.createElement;

        var inject = ["slots"];
        var API = "api/plugin-source-link";
        var MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

        /** 自动推断来源的中文标签。 */
        var SOURCE_LABELS = {
          "profile-dependency": "profile 依赖",
          "package.json": "包清单元数据",
          "git-remote": "本地 Git 远端",
          manual: "手动填写",
          none: "未提取到"
        };

        var STYLE = {
          section: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            boxSizing: "border-box",
            color: "var(--dsw-alias-label-primary, inherit)",
            fontSize: "13px",
            lineHeight: "20px"
          },
          head: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
          title: { margin: 0, fontSize: "14px", fontWeight: 500, lineHeight: "22px" },
          spec: {
            fontFamily: MONO,
            fontSize: "11px",
            color: "var(--dsw-alias-label-caption, #8b8b8b)",
            background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))",
            borderRadius: "4px",
            padding: "1px 6px"
          },
          badge: {
            fontSize: "10px",
            lineHeight: "16px",
            padding: "0 7px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
            color: "var(--dsw-alias-label-caption, #8b8b8b)"
          },
          badgeManual: {
            fontSize: "10px",
            lineHeight: "16px",
            padding: "0 7px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-state-business-primary, #4f7cff)",
            color: "var(--dsw-alias-state-business-primary, #4f7cff)"
          },
          row: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" },
          label: { flex: "none", width: "32px", color: "var(--dsw-alias-label-caption, #8b8b8b)", fontSize: "12px" },
          link: {
            color: "var(--dsw-alias-state-business-primary, #4f7cff)",
            textDecoration: "none",
            wordBreak: "break-all"
          },
          path: {
            fontFamily: MONO,
            fontSize: "12px",
            wordBreak: "break-all",
            color: "var(--dsw-alias-label-secondary, inherit)"
          },
          muted: { color: "var(--dsw-alias-label-tertiary, #999)" },
          error: { margin: 0, color: "var(--dsw-alias-state-error-primary, #d9534f)", fontSize: "12px" },
          editor: {
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "10px",
            borderRadius: "8px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))"
          },
          fieldLabel: { fontSize: "11px", color: "var(--dsw-alias-label-caption, #8b8b8b)" },
          input: {
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
            background: "var(--dsw-alias-bg-layer-2, transparent)",
            color: "inherit",
            font: "inherit"
          },
          actions: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
          primary: {
            padding: "4px 12px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-state-business-primary, #4f7cff)",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            cursor: "pointer"
          },
          mini: {
            padding: "3px 10px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            cursor: "pointer"
          }
        };

        //#region 共享缓存：所有 section 实例共用一份按包名索引的结果
        var cache = { entries: {}, inflight: {} };
        var listeners = new Set();

        function notify() {
          listeners.forEach(function (listener) {
            try {
              listener();
            } catch (error) {
              /* 单个订阅者抛错不影响其余 */
            }
          });
        }

        function subscribe(listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        }

        /** 订阅缓存并在任何变化时重渲染。 */
        function useCache() {
          var pair = react.useState(0);
          react.useEffect(function () {
            return subscribe(function () {
              pair[1](function (tick) {
                return tick + 1;
              });
            });
          }, []);
          return cache;
        }

        /** 取 JSON；403 表示当前不在本机浏览器里。 */
        function fetchJson(path, init) {
          return fetch(path, init).then(function (response) {
            return response
              .json()
              .catch(function () {
                return {};
              })
              .then(function (body) {
                if (response.status === 403) throw new Error("仅在本机浏览器中可用");
                if (!response.ok || body.ok === false) {
                  throw new Error((body && body.error) || "HTTP " + response.status);
                }
                return body;
              });
          });
        }

        /** 拉取一个包的来源（已在缓存中的结果不重复请求）。 */
        function loadEntry(packageName, force) {
          if (!packageName) return;
          if (!force) {
            var current = cache.entries[packageName];
            if (current && (current.loading || current.ok || current.error)) return;
          }
          if (cache.inflight[packageName]) return;
          cache.inflight[packageName] = true;
          cache.entries[packageName] = { loading: true };
          notify();
          fetchJson(API + "/one?name=" + encodeURIComponent(packageName))
            .then(function (body) {
              cache.entries[packageName] = { loading: false, ok: true, data: body.entry };
            })
            .catch(function (error) {
              cache.entries[packageName] = {
                loading: false,
                ok: false,
                error: String(error && error.message ? error.message : error)
              };
            })
            .then(function () {
              delete cache.inflight[packageName];
              notify();
            });
        }

        function postJson(path, payload) {
          return fetchJson(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
        }

        /** 保存手动填写的来源。 */
        function saveManual(packageName, url, localPath) {
          return postJson(API + "/set", { name: packageName, url: url, path: localPath }).then(function (body) {
            cache.entries[packageName] = { loading: false, ok: true, data: body.entry };
            notify();
          });
        }

        /** 清除手动值，回到自动推断结果。 */
        function clearManual(packageName) {
          return postJson(API + "/clear", { name: packageName }).then(function (body) {
            cache.entries[packageName] = { loading: false, ok: true, data: body.entry };
            notify();
          });
        }

        /** 复制文本：优先异步剪贴板，失败回退到临时 textarea。 */
        function copyText(text) {
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              navigator.clipboard.writeText(text)["catch"](function () {});
              return;
            }
          } catch (error) {
            /* 回退到 execCommand */
          }
          try {
            var area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "readonly");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
          } catch (error) {
            /* 复制失败时静默 */
          }
        }

        /** 详情页 subject → 包名。 */
        function subjectName(subject) {
          if (!subject || typeof subject !== "object") return undefined;
          if (subject.kind === "bundle" || subject.kind === "row") {
            return subject.pkg && typeof subject.pkg.name === "string" ? subject.pkg.name : undefined;
          }
          if (subject.kind === "item" && typeof subject.id === "string") return subject.id;
          return undefined;
        }
        //#endregion

        function SourceLinkSection(props) {
          useCache();
          var packageName = subjectName(props.subject);

          var formPair = react.useState({ open: false, url: "", path: "" });
          var form = formPair[0];
          var setForm = formPair[1];
          var busyPair = react.useState(false);
          var busy = busyPair[0];
          var setBusy = busyPair[1];
          var errorPair = react.useState(null);
          var error = errorPair[0];
          var setError = errorPair[1];

          react.useEffect(
            function () {
              if (packageName) loadEntry(packageName, false);
            },
            [packageName]
          );

          if (!packageName) return null;

          var record = cache.entries[packageName];
          var data = record && record.ok ? record.data : null;
          var loading = !record || record.loading === true;
          var manualActive = !!(data && data.manual);
          var url = data && data.url ? data.url : null;
          var localPath = data && data.path ? data.path : null;
          var sourceLabel = data ? SOURCE_LABELS[data.resolvedFrom] || "" : "";

          function openEditor() {
            setError(null);
            setForm({
              open: true,
              url: data && data.manual && data.manual.url ? data.manual.url : "",
              path: data && data.manual && data.manual.path ? data.manual.path : ""
            });
          }

          function submit() {
            setBusy(true);
            setError(null);
            saveManual(packageName, form.url.trim(), form.path.trim())
              .then(function () {
                setForm({ open: false, url: "", path: "" });
              })
              .catch(function (reason) {
                setError(String(reason && reason.message ? reason.message : reason));
              })
              .then(function () {
                setBusy(false);
              });
          }

          function removeManual() {
            setBusy(true);
            setError(null);
            clearManual(packageName)
              .catch(function (reason) {
                setError(String(reason && reason.message ? reason.message : reason));
              })
              .then(function () {
                setBusy(false);
              });
          }

          var children = [
            h(
              "div",
              { key: "head", style: STYLE.head },
              h("h3", { style: STYLE.title }, "插件来源"),
              data && data.spec ? h("code", { key: "spec", style: STYLE.spec, title: "profile 依赖 spec" }, data.spec) : null,
              manualActive
                ? h("span", { key: "badge", style: STYLE.badgeManual }, "手动填写")
                : sourceLabel
                  ? h("span", { key: "badge", style: STYLE.badge }, sourceLabel)
                  : null
            )
          ];

          if (loading) {
            children.push(h("p", { key: "loading", style: STYLE.muted }, "正在读取来源信息…"));
          } else if (record && record.ok === false) {
            children.push(h("p", { key: "failed", style: STYLE.error }, "读取失败：" + record.error));
          } else {
            children.push(
              h(
                "div",
                { key: "url", style: STYLE.row },
                h("span", { style: STYLE.label }, "仓库"),
                url
                  ? h("a", { style: STYLE.link, href: url, target: "_blank", rel: "noreferrer noopener" }, url)
                  : h("span", { style: STYLE.muted }, "数据目录里没有找到仓库地址"),
                url
                  ? h(
                      "button",
                      {
                        style: STYLE.mini,
                        onClick: function () {
                          copyText(url);
                        }
                      },
                      "复制"
                    )
                  : null
              )
            );
            children.push(
              h(
                "div",
                { key: "path", style: STYLE.row },
                h("span", { style: STYLE.label }, "本地"),
                localPath
                  ? h("code", { style: STYLE.path, title: localPath }, localPath)
                  : h("span", { style: STYLE.muted }, "没有找到本地路径"),
                localPath
                  ? h(
                      "button",
                      {
                        style: STYLE.mini,
                        onClick: function () {
                          copyText(localPath);
                        }
                      },
                      "复制"
                    )
                  : null
              )
            );
          }

          if (form.open) {
            children.push(
              h(
                "div",
                { key: "editor", style: STYLE.editor },
                h("label", { style: STYLE.fieldLabel }, "仓库 URL（http(s) 或 git 地址）"),
                h("input", {
                  style: STYLE.input,
                  value: form.url,
                  placeholder: "https://github.com/owner/repo",
                  onChange: function (event) {
                    setForm({ open: true, url: event.target.value, path: form.path });
                  }
                }),
                h("label", { style: STYLE.fieldLabel }, "本地仓库路径"),
                h("input", {
                  style: STYLE.input,
                  value: form.path,
                  placeholder: "D:\\src\\my-plugin",
                  onChange: function (event) {
                    setForm({ open: true, url: form.url, path: event.target.value });
                  }
                }),
                error ? h("p", { style: STYLE.error }, error) : null,
                h(
                  "div",
                  { style: STYLE.actions },
                  h(
                    "button",
                    { style: STYLE.primary, disabled: busy, onClick: submit },
                    busy ? "保存中…" : "保存"
                  ),
                  h(
                    "button",
                    {
                      style: STYLE.mini,
                      disabled: busy,
                      onClick: function () {
                        setForm({ open: false, url: "", path: "" });
                        setError(null);
                      }
                    },
                    "取消"
                  ),
                  manualActive
                    ? h("button", { style: STYLE.mini, disabled: busy, onClick: removeManual }, "清除手动值")
                    : null
                )
              )
            );
          } else {
            children.push(
              h(
                "div",
                { key: "edit", style: STYLE.actions },
                h("button", { style: STYLE.mini, onClick: openEditor }, manualActive ? "修改手动填写" : "没有？我自己填")
              )
            );
          }

          return h(
            "section",
            {
              style: STYLE.section,
              "data-source-link": packageName,
              "data-source-from": data ? data.resolvedFrom : "pending"
            },
            children
          );
        }

        /** 把区块注册进官方插件面板的详情页席位。 */
        function apply(ctx) {
          try {
            ctx.slots.inject("plugins.detail.section", function () {
              try {
                return ctx.slots.register(
                  { name: "plugins.detail.section", id: "source-link", order: 40 },
                  SourceLinkSection
                );
              } catch (error) {
                console.warn("[plugin-source-link] section registration refused", error);
                return function () {};
              }
            });
          } catch (error) {
            console.warn("[plugin-source-link] slots unavailable", error);
          }
        }

        exports.name = "dsh-plugin-source-link";
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
      }
    });
  } catch (err) {
    console.warn("[plugin-source-link] client runtime error:", err);
  }
})();

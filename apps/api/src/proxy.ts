/**
 * 出网代理装配。
 *
 * 打包后服务端跑在 Electron 主进程里，所有厂商适配器用的都是全局 fetch（undici）。
 * Node 的全局 fetch **不读系统代理**，所以用户开着 Clash 也连不上墙外的接口，
 * 只能靠命令行先把 NODE_USE_ENV_PROXY/HTTPS_PROXY 设好再启动进程（运行时再设无效）。
 *
 * 这里在服务启动前装配一次全局 dispatcher，解析顺序：
 *   MIWO_PROXY（旧名 TOONFLOW_PROXY 已废弃）> HTTPS_PROXY/HTTP_PROXY > Windows 系统代理注册表 > 直连
 * 从注册表取到的地址会先做一次 TCP 探活，避免「Clash 退出但系统代理残留」把出网全搞挂。
 *
 * ⚠ 四个标准代理变量（`HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`）**刻意保留原名**：
 *   undici 的 `EnvHttpProxyAgent`（:122 装配的那个）只认这些名字 —— 改名等于让代理配置失效。
 *   它们也是 `tools/check-config-single-source.cjs` 豁免表里**唯一**的四个名字。
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { config } from "@/config";

/** 本地与私有网段不走代理：应用自身端口、局域网内的服务端/中转站 */
const NO_PROXY = ["localhost", "127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].join(",");

const REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

let installed = false;

/** 补上协议头，`127.0.0.1:7897` 与 `http://127.0.0.1:7897` 都接受 */
function normalize(addr: string | undefined): string | null {
  const v = (addr ?? "").trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

/**
 * 解析注册表 ProxyServer 的值。两种形态：
 *   裸地址                 127.0.0.1:7897
 *   按协议分段   http=127.0.0.1:7897;https=127.0.0.1:7897
 */
export function pickProxyServer(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (!value.includes("=")) return normalize(value);

  const byScheme = new Map<string, string>();
  for (const part of value.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const scheme = part.slice(0, i).trim().toLowerCase();
    const addr = part.slice(i + 1).trim();
    if (addr && !byScheme.has(scheme)) byScheme.set(scheme, addr);
  }
  return normalize(byScheme.get("https") ?? byScheme.get("http"));
}

function readSystemProxy(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", REG_PATH], { encoding: "utf-8", timeout: 2000, windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return null;
    return pickProxyServer(/ProxyServer\s+REG_SZ\s+(.*)/i.exec(out)?.[1]);
  } catch {
    return null;
  }
}

/** 明确表示「这个地址没人可用」的错误码 */
const DEAD_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * 代理端口是否可用。
 *
 * 判死必须**明确**：要防的场景是「Clash 退出但系统代理残留」，那个形态是秒回 ECONNREFUSED。
 * 连接超时**不**作为判死依据 —— 应用启动期事件循环繁忙时，socket 的定时器可能先于 connect
 * 的 I/O 回调触发，把活着的代理误判成死的（实测踩到过），误判的代价是整个墙外链路失效。
 */
export function probe(proxyUrl: string, timeout = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(proxyUrl);
    } catch {
      return resolve(false);
    }
    const socket = net.connect({ host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) => done(!DEAD_CODES.has(err.code ?? "")));
  });
}

/** 幂等；任何失败都只降级为直连，不影响服务启动 */
export async function installProxy(): Promise<void> {
  if (installed) return;
  installed = true;

  try {
    // ⚠ Phase 1c Task 10：`TOONFLOW_PROXY` → **`MIWO_PROXY`**（Phase 0 ledger 已裁定的重命名），
    //   收进唯一配置入口 `config.proxyUrl`。旧名**不再读取**。
    const explicit = normalize(config.proxyUrl);
    // ⚠ 这四个是**标准代理变量**（`HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`），
    //   **刻意保留原名**：undici 的 `EnvHttpProxyAgent`（下面 `setGlobalDispatcher` 用的那个）
    //   读的就是它们 —— 改成 `MIWO_*` 等于让代理配置彻底失效。
    //   它们是 `tools/check-config-single-source.cjs` 的**唯一豁免项**（豁免表里逐条附了这条理由）。
    const fromEnv = normalize(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);

    let proxyUrl = explicit ?? fromEnv;
    let source = explicit ? "MIWO_PROXY" : "环境变量";

    // 显式配置一律尊重；只有从注册表自动探测来的才做探活
    if (!proxyUrl) {
      const systemProxy = readSystemProxy();
      if (systemProxy && (await probe(systemProxy))) {
        proxyUrl = systemProxy;
        source = "系统代理";
      } else if (systemProxy) {
        console.warn(`[代理] 系统代理 ${systemProxy} 无响应，已退回直连`);
      }
    }

    if (!proxyUrl) {
      console.log("[代理] 直连（未检测到可用代理）");
      return;
    }

    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: NO_PROXY }));
    console.log(`[代理] 启用 → ${proxyUrl}（来源：${source}）`);
  } catch (err) {
    console.warn("[代理] 初始化失败，已退回直连:", err);
  }
}

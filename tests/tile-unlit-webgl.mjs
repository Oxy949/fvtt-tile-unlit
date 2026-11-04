// Node 22+: node tests/tile-unlit-webgl.mjs <pixi.js> <chrome.exe> [Foundry client directory]
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [pixiPath, chromePath, foundryClientPath] = process.argv.slice(2);
if (!pixiPath || !chromePath) throw new Error("Pass paths to PIXI 7 and Chrome; optionally pass Foundry's client directory for the real SnowShader.");
const modulePath = process.env.TILE_UNLIT_MODULE_PATH ?? fileURLToPath(new URL("../scripts/tile-unlit.js", import.meta.url));
let snowSource = "window.foundrySnowShader = null;";
if (foundryClientPath) {
  const weatherShaders = join(foundryClientPath, "canvas", "rendering", "shaders", "weather");
  const sources = await Promise.all(["base-weather.mjs", "snow.mjs", "fog.mjs"].map(name => readFile(join(weatherShaders, name), "utf8")));
  const macros = (await readFile(join(foundryClientPath, "canvas", "rendering", "mixins", "base-shader-mixin.mjs"), "utf8"))
    .replace("export default function", "function");
  // Only the shader source generators are used. No Foundry source is copied
  // into this repository and no running world is required.
  snowSource = macros + "\nclass AbstractBaseShader extends BaseShaderMixin(class {}) {}\n" + sources.map(source => source
    .replace(/^import .*;\r?\n/gm, "").replace("export default class", "class")).join("\n")
    + "\nwindow.foundrySnowShader = SnowShader._createFragmentShader();"
    + "\nwindow.getFoundryFogShader = () => FogShader._createFragmentShader();";
}
const server = createServer(async (request, response) => {
  try {
    const route = request.url.split("?")[0];
    const paths = {
      "/pixi.js": pixiPath,
      "/module.js": modulePath,
      "/weather-pass.js": join(dirname(modulePath), "weather-pass.js"),
      "/template.hbs": join(dirname(modulePath), "..", "templates", "tile-unlit.hbs"),
      "/": fileURLToPath(new URL("./tile-unlit-webgl.html", import.meta.url))
    };
    if (!(route in paths) && route !== "/snow-source.js") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", route.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(route === "/snow-source.js" ? snowSource : await readFile(paths[route]));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "tile-unlit-webgl-"));
const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"
], { windowsHide: true, stdio: "ignore" });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      break;
    } catch { await delay(100); }
  }
  if (!port) throw new Error("Chrome did not start");
  const tabs = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const browserErrors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      browserErrors.push(message.params.args.map(argument => argument.value ?? argument.description).join(" "));
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(message.error);
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:" + server.address().port });
  let result;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await send("Runtime.evaluate", { expression: "window.result", returnByValue: true });
    if (response.result?.value) {
      result = response.result.value;
      break;
    }
    if (exceptions.length) throw new Error(JSON.stringify(exceptions));
    await delay(100);
  }
  if (!result) throw new Error("WebGL tests timed out");
  if (browserErrors.length) {
    result.ok = false;
    result.browserErrors = browserErrors;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
  server.close();
}

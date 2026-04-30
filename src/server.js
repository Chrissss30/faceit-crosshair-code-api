import "dotenv/config";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawn } from "node:child_process";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DEMOS_DIR = path.join(DATA_DIR, "demos");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");

const PORT = Number(process.env.PORT || 3010);
const FACEIT_API_KEY = process.env.FACEIT_API_KEY || "";
const FACEIT_BASE_URL = process.env.FACEIT_BASE_URL || "https://open.faceit.com/data/v4";
const FACEIT_WEB_BASE_URL = process.env.FACEIT_WEB_BASE_URL || "https://www.faceit.com";
const FACEIT_WEB_LOCALE = process.env.FACEIT_WEB_LOCALE || "pt-br";
const FACEIT_WEB_USER_AGENT =
  process.env.FACEIT_WEB_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const FACEIT_WEB_USE_CURL_FALLBACK = String(process.env.FACEIT_WEB_USE_CURL_FALLBACK || "1") === "1";
const FACEIT_WEB_BROWSER_FALLBACK = String(process.env.FACEIT_WEB_BROWSER_FALLBACK || "1") === "1";
const FACEIT_WEB_COOKIE = process.env.FACEIT_WEB_COOKIE || "";
const FACEIT_WEB_COOKIE_FILE = process.env.FACEIT_WEB_COOKIE_FILE || "";
const FACEIT_USERNAME = process.env.FACEIT_USERNAME || "";
const FACEIT_PASSWORD = process.env.FACEIT_PASSWORD || "";
const COOKIE_AUTO_REFRESH = String(process.env.COOKIE_AUTO_REFRESH || "1") === "1";
const COOKIE_REFRESH_SECRET = process.env.COOKIE_REFRESH_SECRET || "";
const FACEIT_WEB_STATS_URLS = parseCsv(process.env.FACEIT_WEB_STATS_URLS || "");
const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || "";
const BROWSER_USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || "data/browser-profile";
const BROWSER_HEADLESS = String(process.env.BROWSER_HEADLESS || "0") === "1";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 900);
const DOWNLOAD_DEMOS = String(process.env.DOWNLOAD_DEMOS || "0") === "1";
const DEMO_DOWNLOAD_WITH_CURL = String(process.env.DEMO_DOWNLOAD_WITH_CURL || "1") === "1";
const KEEP_DEMOS = String(process.env.KEEP_DEMOS || "0") === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MAX_DEMO_BYTES = Number(process.env.MAX_DEMO_BYTES || 800_000_000);
const ZSTD_PATH = process.env.ZSTD_PATH || "zstd.exe";
const DEMO_PARSER_COMMAND = process.env.DEMO_PARSER_COMMAND || "";
const CURL_CMD = process.platform === "win32" ? "curl.exe" : "curl";
const CROSSHAIR_RE = /CSGO(?:-[A-Za-z0-9]{5}){5}/g;
const ENV_FILE = path.join(ROOT_DIR, ".env");

// Dynamic cookie state — updated at runtime by auto-refresh
let dynamicCookie = "";

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "faceit-crosshair-code-api",
    faceitApiKeyConfigured: Boolean(FACEIT_API_KEY),
    downloadDemos: DOWNLOAD_DEMOS,
    demoDownloadWithCurl: DEMO_DOWNLOAD_WITH_CURL,
    faceitWebBaseUrl: FACEIT_WEB_BASE_URL,
    faceitWebCookieConfigured: Boolean(getFaceitWebCookie()),
    faceitWebCookieFileConfigured: Boolean(FACEIT_WEB_COOKIE_FILE),
    faceitWebCurlFallback: FACEIT_WEB_USE_CURL_FALLBACK,
    faceitWebBrowserFallback: FACEIT_WEB_BROWSER_FALLBACK,
    browserExecutableConfigured: Boolean(BROWSER_EXECUTABLE_PATH),
    browserHeadless: BROWSER_HEADLESS,
    customFaceitWebStatsUrls: FACEIT_WEB_STATS_URLS.length,
    zstdPath: ZSTD_PATH,
    parserCommandConfigured: Boolean(DEMO_PARSER_COMMAND),
  });
});

app.get("/api/crosshair/:nickname", async (req, res) => {
  try {
    const nickname = String(req.params.nickname || "").trim();
    if (!nickname) {
      return res.type("text/plain").send("Nickname não informado.");
    }

    const result = await getCrosshairCodeForNickname(nickname, {
      refresh: req.query.refresh === "1",
      debug: req.query.debug === "1",
    });

    if (req.query.debug === "1") {
      return res.json({ ok: true, ...result });
    }

    res.type("text/plain").send(result.crosshairCode);
  } catch (error) {
    console.error("[crosshair:error]", {
      code: error?.code,
      status: error?.status,
      message: error?.message,
      stack: error?.stack,
    });

    if (req.query.debug === "1") {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.code || "falha_ao_buscar_crosshair",
        message: error.message || "Erro desconhecido.",
        debug: error.debug || null,
      });
    }

    const friendlyMessage = getFriendlyErrorMessage(error.code, error.status);
    res.status(error.status || 502).type("text/plain").send(friendlyMessage);
  }
});

function getFriendlyErrorMessage(code, status) {
  const messages = {
    nickname_invalido: "Nickname não informado.",
    faceit_api_key_ausente: "Erro de configuração da API.",
    partida_nao_encontrada: "Nenhuma partida recente encontrada para esse jogador.",
    crosshair_nao_encontrada: "Crosshair não encontrada na última partida.",
    demo_download_falhou: "Falha ao baixar a demo da partida.",
    demo_muito_grande: "Demo muito grande para processar.",
    faceit_http_error: status === 404 ? "Jogador não encontrado no FACEIT." : "Erro ao acessar a API do FACEIT.",
    faceit_network_error: "Não foi possível conectar ao FACEIT. Tente novamente.",
  };
  return messages[code] || "Não foi possível buscar a crosshair. Tente novamente mais tarde.";
}

app.get("/api/refresh-cookie", async (req, res) => {
  // Protect the endpoint with a secret if configured
  if (COOKIE_REFRESH_SECRET && req.query.secret !== COOKIE_REFRESH_SECRET) {
    return res.status(401).json({ ok: false, error: "nao_autorizado" });
  }

  if (!FACEIT_USERNAME || !FACEIT_PASSWORD) {
    return res.status(500).json({
      ok: false,
      error: "credenciais_ausentes",
      message: "Configure FACEIT_USERNAME e FACEIT_PASSWORD no .env.",
    });
  }

  try {
    console.log("[cookie_refresh] Iniciando login automatico no FACEIT...");
    const cookie = await refreshFaceitCookie();
    console.log("[cookie_refresh] Cookie atualizado com sucesso. Length:", cookie.length);
    res.json({ ok: true, cookieLength: cookie.length, refreshedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[cookie_refresh:error]", error.message);
    res.status(502).json({ ok: false, error: "falha_no_refresh", message: error.message });
  }
});

async function refreshFaceitCookie() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core nao instalado. Execute: npm install playwright-core");
  }

  const userDataDir = path.isAbsolute(BROWSER_USER_DATA_DIR)
    ? BROWSER_USER_DATA_DIR
    : path.join(ROOT_DIR, BROWSER_USER_DATA_DIR);
  await fs.mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: BROWSER_EXECUTABLE_PATH || undefined,
    userAgent: FACEIT_WEB_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await context.newPage();

    // FACEIT redirects login to accounts.faceit.com
    await page.goto(`${FACEIT_WEB_BASE_URL}/en/login`, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Extra wait for JS to render the login form
    await page.waitForTimeout(4000);

    // The login form may be on accounts.faceit.com after redirect
    // Try main frame first, then look inside any frames
    const fillLoginForm = async (frame) => {
      try {
        await frame.waitForSelector('input[type="email"], input[type="text"][autocomplete*="email"], input[type="text"][autocomplete*="username"]', {
          timeout: 8000,
        });
        await frame.fill('input[type="email"], input[type="text"][autocomplete*="email"], input[type="text"][autocomplete*="username"]', FACEIT_USERNAME);
        await frame.waitForSelector('input[type="password"]', { timeout: 5000 });
        await frame.fill('input[type="password"]', FACEIT_PASSWORD);
        await frame.click('button[type="submit"]');
        return true;
      } catch {
        return false;
      }
    };

    // Try main page first
    let loggedIn = await fillLoginForm(page);

    // If not found, try iframes
    if (!loggedIn) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        loggedIn = await fillLoginForm(frame);
        if (loggedIn) break;
      }
    }

    if (!loggedIn) {
      // Take a screenshot for debugging
      await page.screenshot({ path: path.join(DATA_DIR, "login-debug.png") });
      throw new Error(`Formulario de login nao encontrado. URL atual: ${page.url()}. Screenshot salvo em data/login-debug.png`);
    }

    // Wait for redirect back to faceit.com after login
    await page.waitForURL((url) => url.toString().includes("faceit.com") && !url.toString().includes("accounts.faceit.com"), {
      timeout: 25000,
    }).catch(() => {});

    // Give time for session cookies to be set
    await page.waitForTimeout(3000);

    // Extract cookies from both domains
    const cookies = await context.cookies(["https://www.faceit.com", "https://accounts.faceit.com"]);
    const cookieHeader = cookies
      .filter((c) => c.domain.includes("faceit.com"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    if (!cookieHeader) {
      throw new Error("Nenhum cookie encontrado apos login. Verifique as credenciais.");
    }

    // Update runtime state
    dynamicCookie = cookieHeader;

    // Persist to .env file
    await updateEnvFile("FACEIT_WEB_COOKIE", cookieHeader);

    return cookieHeader;
  } finally {
    await context.close().catch(() => {});
  }
}

async function updateEnvFile(key, value) {
  let content = "";
  try {
    content = await fs.readFile(ENV_FILE, "utf8");
  } catch {
    // .env doesn't exist yet, will create
  }

  const escapedValue = value.replace(/\n/g, "\\n");
  const newLine = `${key}=${escapedValue}`;
  const keyRegex = new RegExp(`^${key}=.*$`, "m");

  if (keyRegex.test(content)) {
    content = content.replace(keyRegex, newLine);
  } else {
    content = content.trimEnd() + `\n${newLine}\n`;
  }

  await fs.writeFile(ENV_FILE, content, "utf8");
}

// Schedule auto-refresh every 7 days if credentials are configured
if (COOKIE_AUTO_REFRESH && FACEIT_USERNAME && FACEIT_PASSWORD) {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    try {
      console.log("[cookie_refresh:auto] Renovando cookie automaticamente...");
      await refreshFaceitCookie();
      console.log("[cookie_refresh:auto] Cookie renovado com sucesso.");
    } catch (error) {
      console.error("[cookie_refresh:auto:error]", error.message);
    }
  }, SEVEN_DAYS_MS);
  console.log("[cookie_refresh:auto] Agendado para renovar em 7 dias.");
}



async function getCrosshairCodeForNickname(nickname, { refresh = false, debug = false } = {}) {
  const steps = [];
  const step = (name, ok, detail = {}) => {
    if (debug) steps.push({ name, ok, ...detail });
  };

  if (!FACEIT_API_KEY) {
    throw httpError(500, "faceit_api_key_ausente", "Configure FACEIT_API_KEY no .env.");
  }

  await ensureDirs();
  const cacheKey = normalizeCacheKey(nickname);
  const cached = refresh ? null : await readCacheEntry(cacheKey);
  if (cached) {
    step("cache", true, { source: cached.source || "cache" });
    return { ...cached, debugSteps: steps };
  }
  step("cache", false, { reason: refresh ? "refresh=1" : "miss" });

  let player;
  try {
    player = await fetchFaceitJson(`/players?nickname=${encodeURIComponent(nickname)}&game=cs2`);
    step("faceit_player", true, { playerId: player.player_id, nickname: player.nickname || nickname });
  } catch (error) {
    attachDebug(error, steps);
    throw error;
  }

  let latestMatch;
  try {
    latestMatch = await fetchLatestMatch(player.player_id);
    step("latest_match", true, { matchId: latestMatch.match_id });
  } catch (error) {
    attachDebug(error, steps);
    throw error;
  }

  const [matchDetails, matchStats] = await Promise.all([
    fetchFaceitJson(`/matches/${latestMatch.match_id}`).catch((error) => {
      step("match_details", false, { error: error.code || error.message });
      return {};
    }),
    fetchFaceitJson(`/matches/${latestMatch.match_id}/stats`).catch((error) => {
      step("match_stats", false, { error: error.code || error.message });
      return {};
    }),
  ]);
  if (Object.keys(matchDetails).length) step("match_details", true);
  if (Object.keys(matchStats).length) step("match_stats", true);

  let crosshairCode =
    extractCrosshairCode(matchStats) ||
    extractCrosshairCode(matchDetails) ||
    extractCrosshairCode(latestMatch);
  let source = crosshairCode ? "faceit_data_api" : "";
  step("crosshair_in_data_api", Boolean(crosshairCode), { source });

  if (!crosshairCode) {
    crosshairCode = await fetchCrosshairFromMatchStatsPlayers(latestMatch.match_id, player);
    if (crosshairCode) source = "faceit_match_stats_players";
    step("crosshair_in_match_stats_players", Boolean(crosshairCode), { source });
  }

  if (!crosshairCode) {
    const webStats = await fetchCrosshairFromFaceitWebStats({
      matchId: latestMatch.match_id,
      matchDetails,
      latestMatch,
      player,
      nickname,
      steps,
      debug,
    });
    crosshairCode = webStats.crosshairCode;
    source = webStats.source || "";
    step("crosshair_in_web_stats", Boolean(crosshairCode), { source });
  }

  let demoPath = "";
  if (!crosshairCode && DOWNLOAD_DEMOS) {
    const demoUrl = findDemoUrl(matchDetails) || findDemoUrl(latestMatch);
    step("demo_url", Boolean(demoUrl), { demoUrl });
    if (demoUrl) {
      let scanPath = "";
      try {
        demoPath = await downloadDemo(demoUrl, {
          nickname: player.nickname || nickname,
          matchId: latestMatch.match_id,
        });
        step("demo_download", true, { demoPath });
        scanPath = await maybeDecompressDemo(demoPath);
        step("demo_decompress", true, { scanPath });
        crosshairCode = await scanFileForCrosshairCode(scanPath);
        if (crosshairCode) source = "faceit_demo_scan";
        step("crosshair_in_demo_scan", Boolean(crosshairCode), { source });

        if (!crosshairCode && DEMO_PARSER_COMMAND) {
          const parserOutput = await runParserCommand({
            demoPath: scanPath,
            nickname: player.nickname || nickname,
            playerId: player.player_id,
            matchId: latestMatch.match_id,
          });
          crosshairCode = extractCrosshairCode(parserOutput);
          if (crosshairCode) source = "demo_parser_command";
          step("crosshair_in_parser", Boolean(crosshairCode), { outputPreview: parserOutput.slice(0, 300) });
        }
      } catch (error) {
        step("demo_fallback", false, {
          error: error.code || "demo_fallback_error",
          message: error.message || "Erro desconhecido ao baixar/analisar demo.",
        });
      } finally {
        if (!KEEP_DEMOS) {
          await cleanupDemoFiles([demoPath, scanPath]);
        }
      }
    }
  }

  if (!crosshairCode) {
    const message = DOWNLOAD_DEMOS
      ? "Nao foi encontrado codigo de crosshair na ultima partida."
      : "Nao foi encontrado codigo de crosshair nas estatisticas da FACEIT. As rotas web podem exigir FACEIT_WEB_COOKIE ou FACEIT_WEB_STATS_URLS.";
    const error = httpError(404, "crosshair_nao_encontrada", message);
    attachDebug(error, steps);
    throw error;
  }

  const result = {
    crosshairCode,
    nickname: player.nickname || nickname,
    playerId: player.player_id,
    matchId: latestMatch.match_id,
    source,
    fetchedAt: new Date().toISOString(),
  };
  await writeCacheEntry(cacheKey, result);
  return { ...result, debugSteps: steps };
}

async function fetchCrosshairFromMatchStatsPlayers(matchId, player) {
  // The public FACEIT stats API returns player-level data including crosshair codes
  // in the rounds > teams > players array. Try to extract it for the specific player.
  try {
    const stats = await fetchFaceitJson(`/matches/${matchId}/stats`);
    const playerId = player?.player_id;
    const nickname = normalizeComparable(player?.nickname);

    const rounds = stats?.rounds || [];
    for (const round of rounds) {
      const teams = round?.teams || [];
      for (const team of teams) {
        const players = team?.players || [];
        for (const p of players) {
          const isTarget =
            (playerId && p?.player_id === playerId) ||
            (nickname && normalizeComparable(p?.nickname) === nickname);
          if (!isTarget) continue;

          const code =
            getStringCrosshair(p?.crosshair) ||
            getStringCrosshair(p?.crosshairCode) ||
            getStringCrosshair(p?.crosshair_code) ||
            extractCrosshairCode(JSON.stringify(p));
          if (code) return code;
        }
      }
    }
  } catch {
    // Not available or no crosshair field — continue to other methods.
  }
  return "";
}

async function fetchLatestMatch(playerId) {
  for (const game of ["cs2", "csgo"]) {
    const history = await fetchFaceitJson(`/players/${playerId}/history?game=${game}&offset=0&limit=20`).catch(
      () => null,
    );
    const match = history?.items?.find((item) => item?.match_id);
    if (match) return match;
  }
  throw httpError(404, "partida_nao_encontrada", "Nenhuma partida recente encontrada para o jogador.");
}

async function fetchFaceitJson(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `${FACEIT_BASE_URL}${pathname}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${FACEIT_API_KEY}`,
        accept: "application/json",
        "user-agent": "faceit-crosshair-code-api/1.0",
      },
    });

    if (!response.ok) {
      throw httpError(response.status, "faceit_http_error", `FACEIT HTTP ${response.status} em ${pathname}.`);
    }

    return response.json();
  } catch (error) {
    if (error.status) throw error;
    throw httpError(502, "faceit_network_error", `Falha ao chamar FACEIT: ${error.message || "erro de rede"}.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCrosshairFromFaceitWebStats({
  matchId,
  matchDetails,
  latestMatch,
  player,
  nickname,
  steps = [],
  debug = false,
}) {
  const urls = buildFaceitWebStatsUrls({ matchId, matchDetails, latestMatch });

  for (const url of urls) {
    try {
      const payload = await fetchFaceitWebText(url, { matchId }).catch(async (error) => {
        if (!FACEIT_WEB_BROWSER_FALLBACK) throw error;
        return fetchFaceitWebTextWithBrowser(url, { matchId, fetchError: error });
      });
      const crosshairCode = extractCrosshairCodeForPlayer(payload, {
        nickname: player?.nickname || nickname,
        playerId: player?.player_id,
        steamId: getSteamIdFromFaceitPlayer(player),
      });
      if (debug) {
        steps.push({
          name: "faceit_web_probe",
          ok: Boolean(crosshairCode),
          url,
          payloadLength: payload.length,
          crosshairCount: countCrosshairCodes(payload),
          payloadPreview: buildPayloadPreview(payload),
        });
      }
      if (crosshairCode) {
        return { crosshairCode, source: `faceit_web:${url}` };
      }
    } catch (error) {
      if (debug) steps.push({ name: "faceit_web_probe", ok: false, url, error: error.message });
      // These web routes are not public API; skip failures and try the next candidate.
    }
  }

  return { crosshairCode: "", source: "" };
}

function buildFaceitWebStatsUrls({ matchId, matchDetails, latestMatch }) {
  const officialRoomUrl = findFaceitRoomUrl(matchDetails) || findFaceitRoomUrl(latestMatch);
  const templates = [
    ...FACEIT_WEB_STATS_URLS,
    `${FACEIT_WEB_BASE_URL}/api/statistics/v1/cs2/matches/{matchId}/match-rounds/1/scoreboard-summary`,
    `${FACEIT_WEB_BASE_URL}/api/stats/v1/stats/matches/{matchId}`,
    `${FACEIT_WEB_BASE_URL}/api/stats/v1/stats/matches/{matchId}/scoreboard`,
    `${FACEIT_WEB_BASE_URL}/api/stats/v1/stats/matches/{matchId}/advanced`,
    `${FACEIT_WEB_BASE_URL}/api/match/v2/matches/{matchId}/stats`,
    `${FACEIT_WEB_BASE_URL}/api/matches/v2/matches/{matchId}/stats`,
    `${FACEIT_WEB_BASE_URL}/${FACEIT_WEB_LOCALE}/cs2/room/{matchId}/scoreboard`,
    `${FACEIT_WEB_BASE_URL}/${FACEIT_WEB_LOCALE}/cs2/room/{matchId}/stats`,
    officialRoomUrl ? `${officialRoomUrl.replace(/\/$/, "")}/scoreboard` : "",
    officialRoomUrl ? `${officialRoomUrl.replace(/\/$/, "")}/stats` : "",
  ];

  return [...new Set(templates.filter(Boolean).map((url) => renderUrlTemplate(url, { matchId })))];
}

async function fetchFaceitWebText(url, { matchId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = buildFaceitWebHeaders({ matchId });

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`FACEIT web HTTP ${response.status}`);
    }
    return response.text();
  } catch (error) {
    if (!FACEIT_WEB_USE_CURL_FALLBACK) throw error;
    return fetchFaceitWebTextWithCurl(url, { matchId, fetchError: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFaceitWebTextWithCurl(url, { matchId, fetchError }) {
  const headers = buildFaceitWebHeaders({ matchId });
  const args = [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--compressed",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }
  args.push(url);

  try {
    return await runCommand(CURL_CMD, args);
  } catch (curlError) {
    throw new Error(`fetch=${fetchError.message || "erro"}; curl=${curlError.message || "erro"}`);
  }
}

async function fetchFaceitWebTextWithBrowser(url, { matchId, fetchError }) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error(`${fetchError.message || "fetch falhou"}; browser=playwright-core nao instalado`);
  }

  const userDataDir = path.isAbsolute(BROWSER_USER_DATA_DIR)
    ? BROWSER_USER_DATA_DIR
    : path.join(ROOT_DIR, BROWSER_USER_DATA_DIR);
  await fs.mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: BROWSER_HEADLESS,
    executablePath: BROWSER_EXECUTABLE_PATH || undefined,
    userAgent: FACEIT_WEB_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const cookieHeader = getFaceitWebCookie();
    const cookies = cookieHeader ? parseCookieHeaderForBrowser(cookieHeader) : [];
    if (cookies.length) {
      try {
        await context.addCookies(cookies);
      } catch (cookieErr) {
        console.warn("[browser:cookie_warning]", cookieErr.message);
      }
    }

    const page = await context.newPage();
    const roomUrl = `${FACEIT_WEB_BASE_URL}/${FACEIT_WEB_LOCALE}/cs2/room/${matchId}/scoreboard`;
    await page.goto(roomUrl, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS }).catch(() => {});

    const result = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        credentials: "include",
        headers: {
          accept: "*/*",
        },
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    }, url);

    if (!result.ok) {
      throw new Error(`browser HTTP ${result.status}`);
    }
    return result.text;
  } catch (browserError) {
    throw new Error(`${fetchError.message || "fetch falhou"}; browser=${browserError.message || "erro"}`);
  } finally {
    await context.close().catch(() => {});
  }
}

function buildFaceitWebHeaders({ matchId }) {
  const headers = {
    accept: "*/*",
    "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: `${FACEIT_WEB_BASE_URL}/${FACEIT_WEB_LOCALE}/cs2/room/${matchId}/scoreboard`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": FACEIT_WEB_USER_AGENT,
  };

  const cookie = getFaceitWebCookie();
  if (cookie) {
    headers.cookie = cookie;
  }

  return headers;
}

async function downloadDemo(demoUrl, { nickname, matchId }) {
  const safeNick = normalizeCacheKey(nickname) || "player";
  const safeMatchId = String(matchId || "match").replace(/[^a-zA-Z0-9_-]/g, "_");
  const extension = getDemoExtension(demoUrl);
  const filePath = path.join(DEMOS_DIR, `${safeNick}-${safeMatchId}${extension}`);

  try {
    const response = await fetch(demoUrl, {
      headers: {
        accept: "*/*",
        "user-agent": "faceit-crosshair-code-api/1.0",
      },
    });

    if (!response.ok || !response.body) {
      throw httpError(response.status || 502, "demo_download_falhou", `Falha ao baixar demo: HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_DEMO_BYTES) {
      throw httpError(413, "demo_muito_grande", "Demo maior que MAX_DEMO_BYTES.");
    }

    let downloaded = 0;
    const limitStream = new TransformStream({
      transform(chunk, controller) {
        downloaded += chunk.byteLength;
        if (downloaded > MAX_DEMO_BYTES) {
          throw new Error("Demo maior que MAX_DEMO_BYTES.");
        }
        controller.enqueue(chunk);
      },
    });

    await pipeline(response.body.pipeThrough(limitStream), createWriteStream(filePath));
    return filePath;
  } catch (error) {
    if (!DEMO_DOWNLOAD_WITH_CURL) {
      throw httpError(502, "demo_download_falhou", `Falha ao baixar demo: ${error.message || "fetch failed"}.`);
    }

    try {
      await downloadDemoWithCurl(demoUrl, filePath);
      return filePath;
    } catch (curlError) {
      throw httpError(
        502,
        "demo_download_falhou",
        `Falha ao baixar demo por fetch e curl. fetch=${error.message || "erro"}; curl=${
          curlError.message || "erro"
        }`,
      );
    }
  }
}

async function downloadDemoWithCurl(demoUrl, filePath) {
  await runCommand(CURL_CMD, [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--retry",
    "2",
    "--retry-delay",
    "2",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "--output",
    filePath,
    demoUrl,
  ]);

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.size) {
    throw new Error("curl finalizou sem arquivo valido.");
  }
  if (stat.size > MAX_DEMO_BYTES) {
    throw httpError(413, "demo_muito_grande", "Demo maior que MAX_DEMO_BYTES.");
  }
}

async function maybeDecompressDemo(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zst")) {
    const outputPath = filePath.replace(/\.zst$/i, "");
    await runCommand(ZSTD_PATH, ["-d", "-f", filePath, "-o", outputPath]);
    return outputPath;
  }

  if (lower.endsWith(".gz")) {
    const outputPath = filePath.replace(/\.gz$/i, "");
    await pipeline(createReadStream(filePath), createGunzip(), createWriteStream(outputPath));
    return outputPath;
  }

  return filePath;
}

async function scanFileForCrosshairCode(filePath) {
  let carry = "";
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const text = carry + chunk.toString("latin1");
    const code = extractCrosshairCode(text);
    if (code) return code;
    carry = text.slice(-128);
  }
  return "";
}

async function runParserCommand(values) {
  const rendered = DEMO_PARSER_COMMAND.replaceAll("{demoPath}", values.demoPath)
    .replaceAll("{nickname}", values.nickname)
    .replaceAll("{playerId}", values.playerId)
    .replaceAll("{matchId}", values.matchId);

  const [command, ...args] = splitCommand(rendered);
  return runCommand(command, args);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(`${stdout}\n${stderr}`.trim());
        return;
      }
      reject(new Error(`${command} saiu com codigo ${code}: ${stderr || stdout}`));
    });
  });
}

function splitCommand(commandLine) {
  const matches = commandLine.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

function extractCrosshairCode(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const matches = text.match(CROSSHAIR_RE);
  return matches?.[0] || "";
}

function countCrosshairCodes(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.match(CROSSHAIR_RE)?.length || 0;
}

function buildPayloadPreview(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function extractCrosshairCodeForPlayer(input, player) {
  const parsed = parseJsonMaybe(input);
  if (parsed) {
    const targeted = findCrosshairForPlayer(parsed, {
      nickname: normalizeComparable(player.nickname),
      playerId: normalizeComparable(player.playerId),
      steamId: normalizeComparable(player.steamId),
    });
    if (targeted) return targeted;
  }

  return extractCrosshairCode(input);
}

function findCrosshairForPlayer(value, player) {
  if (!value || typeof value !== "object") return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCrosshairForPlayer(item, player);
      if (found) return found;
    }
    return "";
  }

  // Check both snake_case (official API) and camelCase (web stats API)
  const idFields = [value.player_id, value.playerId];
  const nicknameFields = [value.nickname, value.nickName];

  const isTarget =
    (player.playerId && idFields.some((f) => normalizeComparable(f) === player.playerId)) ||
    (player.nickname && nicknameFields.some((f) => normalizeComparable(f) === player.nickname));

  if (isTarget) {
    const objectText = JSON.stringify(value);
    const directCode =
      getStringCrosshair(value.crosshair) ||
      getStringCrosshair(value.crosshairCode) ||
      getStringCrosshair(value.crosshair_code) ||
      extractCrosshairCode(objectText);
    if (directCode) return directCode;
  }

  for (const child of Object.values(value)) {
    const found = findCrosshairForPlayer(child, player);
    if (found) return found;
  }

  return "";
}

function getStringCrosshair(value) {
  return typeof value === "string" ? extractCrosshairCode(value) : "";
}

function parseJsonMaybe(input) {
  if (!input) return null;
  if (typeof input === "object") return input;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function includesComparable(haystack, needle) {
  return Boolean(needle && normalizeComparable(haystack).includes(needle));
}

function normalizeComparable(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function findDemoUrl(input) {
  if (Array.isArray(input?.demo_url) && input.demo_url[0]) return input.demo_url[0];
  if (typeof input?.demo_url === "string") return input.demo_url;

  const serialized = JSON.stringify(input || {});
  const match =
    serialized.match(/https?:\/\/[^"\s]+?\.dem(?:\.zst|\.gz|\.bz2|\.zip)?/i) ||
    serialized.match(/https?:\/\/[^"\s]+demo[^"\s]*/i);
  return match?.[0] || "";
}

function findFaceitRoomUrl(input) {
  if (typeof input?.faceit_url === "string") return input.faceit_url.replace("{lang}", FACEIT_WEB_LOCALE);
  if (typeof input?.match_url === "string") return input.match_url;

  const serialized = JSON.stringify(input || {});
  const match = serialized.match(/https?:\/\/(?:www\.)?faceit\.com\/[^"\s]+\/cs2\/room\/[^"\s]+/i);
  return match?.[0]?.replace("{lang}", FACEIT_WEB_LOCALE) || "";
}

function getSteamIdFromFaceitPlayer(player) {
  const games = player?.games || {};
  const candidates = [games?.cs2?.game_player_id, games?.csgo?.game_player_id, player?.steam_id];
  for (const value of candidates) {
    const id = String(value || "").trim();
    if (/^\d{17}$/.test(id)) return id;
  }
  return "";
}

function getDemoExtension(url) {
  const cleanUrl = url.split("?")[0].toLowerCase();
  const match = cleanUrl.match(/(\.dem(?:\.zst|\.gz|\.bz2|\.zip)?|\.zst|\.gz)$/i);
  return match?.[1] || ".dem";
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DEMOS_DIR, { recursive: true });
}

async function readCacheEntry(key) {
  const cache = await readCache();
  const entry = cache[key];
  if (!entry?.crosshairCode || !entry?.fetchedAt) return null;

  const ageSeconds = (Date.now() - new Date(entry.fetchedAt).getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > CACHE_TTL_SECONDS) return null;
  return entry;
}

async function writeCacheEntry(key, value) {
  const cache = await readCache();
  cache[key] = value;
  await fs.writeFile(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function cleanupDemoFiles(files) {
  for (const file of new Set(files.filter(Boolean))) {
    try {
      if (path.resolve(file).startsWith(path.resolve(DEMOS_DIR))) {
        await fs.unlink(file);
      }
    } catch {
      // Best effort cleanup only.
    }
  }
}

function normalizeCacheKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function renderUrlTemplate(template, values) {
  return template.replaceAll("{matchId}", encodeURIComponent(values.matchId));
}

function parseCsv(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getFaceitWebCookie() {
  // Priority: runtime refreshed cookie > env var > cookie file
  if (dynamicCookie.trim()) return normalizeCookieHeader(dynamicCookie);
  if (FACEIT_WEB_COOKIE.trim()) return normalizeCookieHeader(FACEIT_WEB_COOKIE);
  if (!FACEIT_WEB_COOKIE_FILE.trim()) return "";

  try {
    const cookiePath = path.isAbsolute(FACEIT_WEB_COOKIE_FILE)
      ? FACEIT_WEB_COOKIE_FILE
      : path.join(ROOT_DIR, FACEIT_WEB_COOKIE_FILE);
    return normalizeCookieHeader(readFileSync(cookiePath, "utf8"));
  } catch {
    return "";
  }
}

function normalizeCookieHeader(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^cookie:?$/i.test(line))
    .map((line) => line.replace(/^cookie:\s*/i, ""))
    .join("; ")
    .replace(/;{2,}/g, ";")
    .trim();
}

function parseCookieHeaderForBrowser(cookieHeader) {
  const normalized = normalizeCookieHeader(cookieHeader);
  if (!normalized) return [];
  return normalized
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: "faceit.com",
        path: "/",
        secure: true,
        sameSite: "None",
      };
    })
    .filter(Boolean);
}

function sendTextError(res, status, code) {
  res.status(status).type("text/plain").send(code);
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function attachDebug(error, steps) {
  error.debug = { steps };
  return error;
}

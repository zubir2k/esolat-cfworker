/**
 * esolat-mcp — Cloudflare Worker Edition
 * MCP Streamable HTTP server for Malaysian prayer times, mosque finder, Islamic events
 * Compatible with M365 Copilot, Claude.ai, and any MCP Streamable HTTP client
 *
 * Powered by:
 * - esolat (npm): Malaysian prayer times & Islamic calendar milestones
 * - jejakmasjid (npm): Malaysian masjid & surau geolocation database
 *
 * Repo: https://github.com/zubir2k/esolat-cfworker
 * Author: Muhammad Zubir Jamalullail
 */

import { getCurrentTimeUtc, getIslamicEvents, getPrayerTimes, isMalaysia } from "esolat";
import { fetchNearby } from "jejakmasjid";

export interface Env {
  MCP_WEBHOOK_TOKEN: string;
}

// ─── MCP Protocol Types ────────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool Definitions (MCP schema) ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_monthly_prayer_times",
    description:
      "Fetches the full monthly prayer schedule (Fajr, Syuruk, Dhuha, Dhuhr, Asr, Maghrib, Isha). " +
      "Accepts a place name OR latitude/longitude. Returns Gregorian + Hijri dates. " +
      "Dhuha is auto-computed (+28 minutes after Syuruk). Uses JAKIM/e-Solat for Malaysia, Aladhan API globally.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: {
          type: "string",
          description: "Place name e.g. 'Kuala Lumpur', 'Kajang', 'Johor Bahru'",
        },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        month: { type: "integer", description: "Month number 1-12 (default: current month)", minimum: 1, maximum: 12 },
        year: { type: "integer", description: "4-digit year (default: current year)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "find_nearest_mosques",
    description:
      "Finds up to 15 nearest mosques/masjids/suraus within a given radius. " +
      "Powered by JejakMasjid (with JAKIM e-solat fallback for Malaysia). " +
      "Returns name, type, distance, cardinal direction, coordinates, Google Maps link, and Waze deep link.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Place name to search from" },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        distance_km: {
          type: "integer",
          description: "Search radius in km (default: 5)",
          minimum: 1, maximum: 50,
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_current_time",
    description:
      "Returns the current server UTC time. " +
      "Call this first when the user asks about current prayer status, time remaining to next prayer, " +
      "or any query requiring comparison of current time against prayer times. " +
      "For the Hijri date, use get_monthly_prayer_times or get_yearly_islamic_events instead.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_yearly_islamic_events",
    description:
      "Returns major Islamic calendar events and public holidays for a given year. " +
      "Malaysia routing uses official JAKIM e-Solat data. Falls back to Aladhan API globally.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Place name for Malaysia/global routing" },
        latitude: { type: "number", description: "GPS latitude" },
        longitude: { type: "number", description: "GPS longitude" },
        target_year: {
          type: "integer",
          description: "4-digit year (default: current year)",
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ─── Location Resolver ─────────────────────────────────────────────────────────

async function resolveLocation(
  locationName?: string,
  latitude?: number,
  longitude?: number
): Promise<[number, number]> {
  if (latitude !== undefined && longitude !== undefined) {
    return [latitude, longitude];
  }
  if (locationName) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "esolat-mcp-cf/2.1 (Cloudflare Worker)" },
    });
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) throw new Error(`Location '${locationName}' could not be resolved.`);
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  }
  throw new Error("Provide either location_name or latitude/longitude coordinates.");
}

// ─── Tool Implementations ──────────────────────────────────────────────────────

async function toolGetPrayerTimes(args: Record<string, unknown>): Promise<unknown> {
  const [lat, lon] = await resolveLocation(
    args.location_name as string | undefined,
    args.latitude as number | undefined,
    args.longitude as number | undefined
  );

  const now = new Date();
  const month = (args.month as number) ?? now.getUTCMonth() + 1;
  const year = (args.year as number) ?? now.getUTCFullYear();

  const result = await getPrayerTimes({
    latitude: lat,
    longitude: lon,
    month,
    year,
  });

  return {
    current_time_utc: result.currentTimeUtc,
    zone: result.zone,
    prayers: result.prayers.map((p) => ({
      date: p.date,
      day_name: p.dayName,
      hijri_raw: p.hijriRaw,
      hijri_full: p.hijriFull,
      fajr: p.fajr,
      syuruk: p.syuruk,
      dhuha: p.dhuha,
      dhuhr: p.dhuhr,
      asr: p.asr,
      maghrib: p.maghrib,
      isha: p.isha,
    })),
  };
}

async function toolFindMosques(args: Record<string, unknown>): Promise<unknown> {
  const [lat, lon] = await resolveLocation(
    args.location_name as string | undefined,
    args.latitude as number | undefined,
    args.longitude as number | undefined
  );
  const distKm = (args.distance_km as number) ?? 5;
  const mosqueList: Array<Record<string, unknown>> = [];

  // 1. Primary: JejakMasjid (mode: "map" for wide coverage)
  try {
    const places = await fetchNearby({
      latitude: lat,
      longitude: lon,
      radiusKm: distKm,
      mode: "map",
    });

    for (const p of places) {
      const dist = p.distanceKm != null ? Math.round(p.distanceKm * 100) / 100 : undefined;
      mosqueList.push({
        name: p.name.trim(),
        type: p.type,
        distance_km: dist,
        coordinates: { latitude: p.latitude, longitude: p.longitude },
        google_maps_link: p.googleMapsLink,
        waze_link: p.wazeLink,
        ...(p.direction ? { direction: p.direction } : {}),
        ...(p.url ? { url: p.url } : {}),
        ...(p.kursusHaji != null ? { kursus_haji: p.kursusHaji } : {}),
      });
    }
  } catch (err) {
    console.warn("JejakMasjid query failed or outside region:", err);
  }

  // 2. Fallback for Malaysia: JAKIM e-solat SISMIM API
  if (mosqueList.length === 0 && isMalaysia(lat, lon)) {
    try {
      const url = `https://www.e-solat.gov.my/index.php?r=esolatApi/nearestMosque&lat=${lat}&long=${lon}&dist=${distKm}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { locationData?: Array<Record<string, unknown>> };
        for (const item of data.locationData ?? []) {
          const mLat = parseFloat(item.latitud as string);
          const mLon = parseFloat(item.longitud as string);
          mosqueList.push({
            name: (item.nama_masjid as string).trim(),
            type: "masjid",
            distance_km: Math.round(parseFloat(item.distance as string) * 100) / 100,
            coordinates: { latitude: mLat, longitude: mLon },
            google_maps_link: `https://maps.google.com/?q=${mLat},${mLon}`,
            waze_link: `https://waze.com/ul?ll=${mLat},${mLon}&navigate=yes&z=10`,
          });
        }
      }
    } catch (err) {
      console.warn("JAKIM fallback error fetching mosques:", err);
    }
  }

  mosqueList.sort((a, b) => ((a.distance_km as number) ?? 0) - ((b.distance_km as number) ?? 0));
  return mosqueList.slice(0, 15);
}

async function toolGetIslamicEvents(args: Record<string, unknown>): Promise<unknown> {
  let localRoute = true;
  try {
    const [lat, lon] = await resolveLocation(
      args.location_name as string | undefined,
      args.latitude as number | undefined,
      args.longitude as number | undefined
    );
    localRoute = isMalaysia(lat, lon);
  } catch {
    localRoute = true;
  }

  const targetYear = (args.target_year as number) ?? new Date().getUTCFullYear();
  const events = await getIslamicEvents({
    year: targetYear,
    isMalaysia: localRoute,
  });

  return events.map((e) => ({
    event_name: e.eventName,
    gregorian_date: e.gregorianDate,
    hijri_date: e.hijriDate,
  }));
}

// ─── MCP Request Router ────────────────────────────────────────────────────────

async function handleMCP(req: MCPRequest): Promise<MCPResponse> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "esolat-mcp", version: "2.1.0" },
          },
        };

      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: args = {} } = (req.params ?? {}) as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        let result: unknown;
        switch (name) {
          case "get_current_time":
            result = {
              current_time_utc: getCurrentTimeUtc().slice(0, 19) + "Z",
              source: "server",
            };
            break;
          case "get_monthly_prayer_times":
            result = await toolGetPrayerTimes(args);
            break;
          case "find_nearest_mosques":
            result = await toolFindMosques(args);
            break;
          case "get_yearly_islamic_events":
            result = await toolGetIslamicEvents(args);
            break;
          default:
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown tool: ${name}` },
            };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : "Internal server error",
      },
    };
  }
}

// ─── Health Dashboard ──────────────────────────────────────────────────────────

async function checkUpstream(url: string, method = "GET"): Promise<string> {
  try {
    const opts: RequestInit =
      method === "POST"
        ? { method: "POST", body: new URLSearchParams({ data: "[out:json][timeout:2];out;" }) }
        : { method: "GET" };
    const res = await fetch(url, {
      ...opts,
      headers: { "User-Agent": "esolat-mcp-cf/2.1 (https://github.com/zubir2k/esolat-cfworker)" },
      signal: AbortSignal.timeout(4000),
    });
    return [200, 400, 404].includes(res.status) ? "CONNECTED" : "DEGRADED";
  } catch {
    return "UNREACHABLE";
  }
}

async function healthDashboard(): Promise<Response> {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();

  const [jakim, waktu, jejak, osm] = await Promise.all([
    checkUpstream("https://www.e-solat.gov.my/index.php?r=esolatApi/islamicevent&type=all"),
    checkUpstream(`https://api.waktusolat.app/v2/solat/gps/3.02/101.79?year=${year}&month=${month}`),
    checkUpstream("https://apiv2.jejakmasjid.my/api/ha/v1/masjids/nearby?lat=3.02&lon=101.79&radius_km=5"),
    checkUpstream("https://nominatim.openstreetmap.org/search?q=Kajang&format=json&limit=1"),
  ]);

  return Response.json({
    server: "esolat-mcp",
    edition: "Cloudflare Worker",
    status: "ONLINE",
    version: "2.1.0",
    timestamp: now.toISOString(),
    upstream_apis: {
      jejak_masjid: jejak,
      jakim_e_solat: jakim,
      waktu_solat_app: waktu,
      openstreetmap_nominatim: osm,
    },
  });
}

// ─── Main Fetch Handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!env.MCP_WEBHOOK_TOKEN) {
      return new Response(
        "Server misconfigured: MCP_WEBHOOK_TOKEN secret is not set.\n" +
          "Run: wrangler secret put MCP_WEBHOOK_TOKEN",
        { status: 500 }
      );
    }
    const token = env.MCP_WEBHOOK_TOKEN;
    const expectedPrefix = `/mcp/${token}`;

    // Root landing page
    if (path === "/" || path === "") {
      return new Response(
        `esolat-mcp (Cloudflare Worker) is running!\n\n` +
          `Health dashboard:  ${url.origin}/mcp/<TOKEN>/health\n` +
          `MCP endpoint:      ${url.origin}/mcp/<TOKEN>/mcp\n\n` +
          `Replace <TOKEN> with your MCP_WEBHOOK_TOKEN secret.`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    // Reject paths outside the token scope
    if (!path.startsWith(expectedPrefix)) {
      return Response.json(
        { error: "Unauthorized: invalid or missing webhook token path." },
        { status: 401 }
      );
    }

    const subPath = path.slice(expectedPrefix.length) || "/";

    // ── Health dashboard (/health) ─────────────────────────────────────────────
    if (subPath === "/health" || subPath === "/health/") {
      return await healthDashboard();
    }

    // ── MCP Streamable HTTP endpoint (/mcp) ───────────────────────────────────
    if (subPath === "/mcp" || subPath === "/mcp/" || subPath === "/") {
      // OPTIONS pre-flight (for M365 Copilot CORS)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
          },
        });
      }

      // GET — some clients probe the endpoint
      if (request.method === "GET") {
        return Response.json({
          jsonrpc: "2.0",
          result: { server: "esolat-mcp", transport: "streamable-http" },
        });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      let body: MCPRequest | MCPRequest[];
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400 }
        );
      }

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json; charset=utf-8",
      };

      // Batch support
      if (Array.isArray(body)) {
        const responses = await Promise.all(body.map(handleMCP));
        return new Response(JSON.stringify(responses), { headers: corsHeaders });
      }

      // Skip response for notifications (no id)
      if (body.method?.startsWith("notifications/")) {
        await handleMCP(body);
        return new Response(null, { status: 202, headers: corsHeaders });
      }

      const response = await handleMCP(body);
      return new Response(JSON.stringify(response), { headers: corsHeaders });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

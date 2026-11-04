type QueryValue = string | boolean | undefined;

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

export class HomeAssistantApi {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, token: string, timeoutMs = 15_000, fetcher: typeof fetch = fetch) {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("HA_BASE_URL must use HTTP or HTTPS");
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error("HA_BASE_URL must not contain credentials, a query, or a fragment");
    }
    if (!token.trim()) throw new Error("HA_TOKEN must not be empty");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Home Assistant request timeout must be positive");

    parsedUrl.pathname = `${parsedUrl.pathname.replace(/\/+$/, "")}/`;
    this.baseUrl = parsedUrl;
    this.token = token.trim();
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
  }

  async getApiStatus(): Promise<unknown> {
    return this.get("api/");
  }

  async getConfig(): Promise<unknown> {
    return this.get("api/config");
  }

  async getComponents(): Promise<unknown> {
    return this.get("api/components");
  }

  async getStates(): Promise<unknown> {
    return this.get("api/states");
  }

  async getState(entityId: string): Promise<unknown> {
    return this.get(`api/states/${encodeURIComponent(entityId)}`);
  }

  async getServices(): Promise<unknown> {
    return this.get("api/services");
  }

  async callService(domain: string, service: string, serviceData: Record<string, unknown>): Promise<unknown> {
    if (!/^[a-z0-9_]+$/i.test(domain)) throw new Error("Home Assistant service domain is invalid");
    if (!/^[a-z0-9_]+$/i.test(service)) throw new Error("Home Assistant service name is invalid");
    return this.request(`api/services/${domain}/${service}`, {}, false, "POST", serviceData);
  }

  async getEvents(): Promise<unknown> {
    return this.get("api/events");
  }

  async getHistory(options: {
    timestamp?: string;
    end_time?: string;
    entity_id?: string;
    minimal_response?: boolean;
  }): Promise<unknown> {
    const timestamp = options.timestamp ? encodeURIComponent(options.timestamp) : "";
    const query: Record<string, QueryValue> = {
      end_time: options.end_time,
      filter_entity_id: options.entity_id,
      minimal_response: options.minimal_response ? true : undefined
    };
    return this.get(`api/history/period/${timestamp}`, query);
  }

  async getLogbook(options: {
    timestamp?: string;
    end_time?: string;
    entity_id?: string;
  }): Promise<unknown> {
    const timestamp = options.timestamp ? encodeURIComponent(options.timestamp) : "";
    return this.get(`api/logbook/${timestamp}`, {
      end_time: options.end_time,
      entity: options.entity_id
    });
  }

  async getErrorLog(): Promise<string> {
    return this.getText("api/error_log");
  }

  async getCalendars(): Promise<unknown> {
    return this.get("api/calendars");
  }

  async getCalendarEvents(entityId: string, start: string, end: string): Promise<unknown> {
    return this.get(`api/calendars/${encodeURIComponent(entityId)}`, { start, end });
  }

  private async get(path: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.request(path, query, false);
  }

  private async getText(path: string): Promise<string> {
    const result = await this.request(path, {}, true);
    if (typeof result !== "string") throw new Error("Home Assistant returned an unexpected text response");
    return result;
  }

  private async request(
    path: string,
    query: Record<string, QueryValue>,
    textResponse: boolean,
    method: "GET" | "POST" = "GET",
    payload?: Record<string, unknown>
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        headers: {
          Accept: textResponse ? "text/plain" : "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {})
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error) throw new Error(`Home Assistant request failed: ${error.message}`);
      throw new Error(`Home Assistant request failed: ${String(error)}`);
    }

    if (!response.ok) throw new Error(`Home Assistant API returned HTTP ${response.status} ${response.statusText}`.trim());
    const body = await response.text();
    if (textResponse) return body;
    if (!body) return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Home Assistant returned invalid JSON");
    }
  }
}

export function toHomeAssistantStates(value: unknown): HomeAssistantState[] {
  if (!Array.isArray(value)) throw new Error("Home Assistant returned an unexpected states response");
  return value.map((entry) => {
    if (!isRecord(entry)
      || typeof entry.entity_id !== "string"
      || typeof entry.state !== "string"
      || !isRecord(entry.attributes)) {
      throw new Error("Home Assistant returned an invalid entity state");
    }
    return {
      entity_id: entry.entity_id,
      state: entry.state,
      attributes: entry.attributes,
      ...(typeof entry.last_changed === "string" ? { last_changed: entry.last_changed } : {})
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

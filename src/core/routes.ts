import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface RouteData {
  routes: Record<string, { threadId: string; lastActiveAt: number; sessionGeneration?: number }>;
  seen: string[];
  sessionGeneration: number;
}

const MAX_SEEN = 2000;

export class RouteStore {
  private readonly file: string;
  private data: RouteData = { routes: {}, seen: [], sessionGeneration: 0 };
  private seen = new Set<string>();
  private saving = Promise.resolve();

  constructor(storageDir: string) {
    this.file = join(storageDir, 'bridge-routes.json');
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as { routes?: Record<string, string | { threadId: string; lastActiveAt: number; sessionGeneration?: number }>; seen?: string[]; sessionGeneration?: number };
      const routes = Object.entries(value.routes ?? {});
      const migratedAt = Date.now();
      this.data = {
        routes: Object.fromEntries(routes.map(([key, route]) => [key, typeof route === 'string'
          ? { threadId: route, lastActiveAt: migratedAt }
          : route])),
        seen: Array.isArray(value.seen) ? value.seen.slice(-MAX_SEEN) : [],
        sessionGeneration: value.sessionGeneration ?? 0,
      };
      this.seen = new Set(this.data.seen);
      if (routes.some(([, route]) => typeof route === 'string')) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  getSessionGeneration(): number {
    return this.data.sessionGeneration;
  }

  getThread(chatId: string, senderOpenId: string): { threadId: string; lastActiveAt: number; sessionGeneration?: number } | undefined {
    return this.data.routes[JSON.stringify([chatId, senderOpenId])];
  }

  async setThread(chatId: string, senderOpenId: string, threadId: string, sessionGeneration = this.data.sessionGeneration): Promise<void> {
    const key = JSON.stringify([chatId, senderOpenId]);
    const previous = this.data.routes[key];
    const next = { threadId, lastActiveAt: Date.now(), sessionGeneration };
    this.data.routes[key] = next;
    try {
      await this.save();
    } catch (error) {
      if (this.data.routes[key] === next) {
        if (previous) this.data.routes[key] = previous;
        else delete this.data.routes[key];
      }
      throw error;
    }
  }

  async requestNewSession(): Promise<void> {
    const previous = this.data.sessionGeneration;
    this.data.sessionGeneration++;
    try {
      await this.save();
    } catch (error) {
      if (this.data.sessionGeneration === previous + 1) this.data.sessionGeneration = previous;
      throw error;
    }
  }

  async touchThread(chatId: string, senderOpenId: string, threadId: string): Promise<void> {
    const route = this.getThread(chatId, senderOpenId);
    if (!route || route.threadId !== threadId) return;
    route.lastActiveAt = Date.now();
    await this.save();
  }

  hasSeen(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  async markSeen(messageId: string): Promise<void> {
    if (this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.data.seen.push(messageId);
    if (this.data.seen.length > MAX_SEEN) {
      this.data.seen = this.data.seen.slice(-MAX_SEEN);
      this.seen = new Set(this.data.seen);
    }
    await this.save();
  }

  private save(): Promise<void> {
    const contents = JSON.stringify(this.data);
    const file = this.file;
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, file);
    });
    return this.saving;
  }
}

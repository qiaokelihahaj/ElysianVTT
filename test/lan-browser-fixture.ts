import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, errors as playwrightErrors, type Browser, type BrowserContext, type Page } from 'playwright';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const EXIT_ASSERTION = 1;
export const EXIT_BROWSER = 2;
export const EXIT_SERVER = 3;
export const EXIT_TIMEOUT = 4;

const repoRoot = path.resolve(__dirname, '..');
const backendEntry = path.join(repoRoot, 'packages', 'backend', 'dist', 'demo', 'index.js');
const frontendEntry = path.join(repoRoot, 'packages', 'frontend', 'dist', 'index.html');
const launchTimeoutMs = 20_000;

export class BrowserEnvironmentError extends Error {}
export class DemoServerError extends Error {}
export class DemoTimeoutError extends Error {}

export interface LanBrowserCredentials {
  hostCredential: string;
  joinCode: string;
}

export interface LanBrowserScenario {
  name: string;
  status: 'passed' | 'failed';
  message?: string;
}

export interface LanBrowserContext {
  name: string;
  context: BrowserContext;
  pages: Page[];
  traceStarted: boolean;
}

function redact(value: string, secrets: readonly string[] = []): string {
  let output = value;
  for (const secret of [...secrets].filter(item => item.length > 0).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  // Trace/network output can contain an access token without the exact value
  // being available to the fixture. Keep this conservative and token-shaped.
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bdemo_[A-Za-z0-9_-]{16,}\b/g, 'demo_[REDACTED]');
}

function fileHash(filename: string): string | null {
  return existsSync(filename) ? createHash('sha256').update(readFileSync(filename)).digest('hex') : null;
}

export function ensureTemporaryDirectory(prefix: string): string {
  const directory = path.resolve(realpathSafe(tmpdir()), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function realpathSafe(filename: string): string {
  try {
    return path.resolve(filename);
  } catch {
    return path.resolve(filename);
  }
}

function isSafeTemporaryDirectory(directory: string, prefix: string): boolean {
  const resolved = path.resolve(directory);
  return path.dirname(resolved) === path.resolve(realpathSafe(tmpdir())) && path.basename(resolved).startsWith(prefix);
}

export function cleanupTemporaryDirectory(directory: string, prefix: string): void {
  if (!isSafeTemporaryDirectory(directory, prefix)) throw new Error(`Refusing to clean unexpected temporary directory: ${directory}`);
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function looksLikeMissingBrowser(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /executable doesn't exist|executable.*not found|browserType\.launch|chromium.*(missing|not found)/i.test(text);
}

export function classifyBrowserLaunchError(error: unknown): BrowserEnvironmentError {
  const text = error instanceof Error ? error.message : String(error);
  if (looksLikeMissingBrowser(error)) return new BrowserEnvironmentError(`Chromium is unavailable: ${text}`);
  return new BrowserEnvironmentError(`Chromium launch failed: ${text}`);
}

export class DemoServerProcess {
  public readonly dataDirectory: string;
  public readonly credentials: LanBrowserCredentials;
  public readonly output: string[] = [];
  public url = '';

  private child?: ChildProcess;
  private stopping = false;

  public constructor(dataDirectory: string, credentials: LanBrowserCredentials) {
    this.dataDirectory = dataDirectory;
    this.credentials = credentials;
  }

  public async start(): Promise<string> {
    if (!existsSync(backendEntry)) throw new DemoServerError(`Built DemoServer is missing: ${backendEntry}`);
    if (!existsSync(frontendEntry)) throw new DemoServerError(`Built frontend is missing: ${frontendEntry}`);
    this.stopping = false;
    const child = spawn(process.execPath, [backendEntry], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELYSIAN_DEMO_DATA_DIR: this.dataDirectory,
        ELYSIAN_DEMO_HOST: '127.0.0.1',
        ELYSIAN_DEMO_PORT: '0',
        ELYSIAN_DEMO_HOST_CREDENTIAL: this.credentials.hostCredential,
        ELYSIAN_DEMO_JOIN_CODE: this.credentials.joinCode,
      },
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => this.capture(String(chunk)));
    child.stderr?.on('data', chunk => this.capture(String(chunk)));
    const exitPromise = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    const startedAt = Date.now();
    while (Date.now() - startedAt < launchTimeoutMs) {
      const match = this.output.join('').match(/ElysianVTT demo listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        this.url = match[1];
        try {
          const response = await fetch(`${this.url}/health`);
          if (!response.ok) throw new Error(`health returned ${response.status}`);
          return this.url;
        } catch (error) {
          throw new DemoServerError(`DemoServer announced readiness but health failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (child.exitCode !== null) {
        const code = await exitPromise;
        throw new DemoServerError(`DemoServer exited before readiness (code ${code}); ${this.output.join('')}`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    throw new DemoServerError(`DemoServer readiness timeout; ${this.output.join('')}`);
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || this.stopping) return;
    this.stopping = true;
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exit, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([exit, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  }

  private capture(chunk: string): void {
    this.output.push(chunk);
    while (this.output.length > 2000) this.output.shift();
  }
}

export function newBrowserContexts(browser: Browser, names: readonly string[]): Promise<LanBrowserContext[]> {
  return Promise.all(names.map(async name => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    return { name, context, pages: [], traceStarted: true };
  }));
}

export async function newPage(owner: LanBrowserContext, url: string): Promise<Page> {
  const page = await owner.context.newPage();
  owner.pages.push(page);
  page.setDefaultTimeout(12_000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  return page;
}

export async function waitForVisible(page: Page, selector: string, label: string, timeout = 12_000): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (error instanceof playwrightErrors.TimeoutError) throw new DemoTimeoutError(`${label} did not become visible within ${timeout}ms`);
    throw error;
  }
}

export async function waitForText(page: Page, text: string, label = text, timeout = 12_000): Promise<void> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (error instanceof playwrightErrors.TimeoutError) throw new DemoTimeoutError(`${label} did not appear within ${timeout}ms`);
    throw error;
  }
}

export async function waitForCondition(page: Page, predicate: () => boolean | Promise<boolean>, label: string, timeout = 12_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new DemoTimeoutError(`${label} did not become true within ${timeout}ms`);
}

async function redactPage(page: Page, secrets: readonly string[]): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate((values) => {
    const replacement = '[REDACTED]';
    const replace = (text: string): string => values.reduce((current, value) => value ? current.split(value).join(replacement) : current, text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    for (const text of nodes) text.textContent = replace(text.textContent ?? '');
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.type === 'password' || values.some(value => value && element.value.includes(value))) element.value = replacement;
      }
      if (element.classList.contains('demo-room-code') || element.classList.contains('demo-input')) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = replacement;
        else if (element.textContent?.trim()) element.textContent = replacement;
      }
    }
  }, [...secrets]);
}

function isTraceText(name: string): boolean {
  return /(^|\/)(trace|network|test|metadata)[^/]*\.(json|txt|html|trace)$/i.test(name) || /\.trace$/i.test(name);
}

function sanitizeTrace(rawPath: string, outputPath: string, secrets: readonly string[]): void {
  const archive = unzipSync(readFileSync(rawPath));
  const safe: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(archive)) {
    safe[name] = isTraceText(name) ? strToU8(redact(strFromU8(bytes), secrets)) : bytes;
  }
  writeFileSync(outputPath, Buffer.from(zipSync(safe, { level: 6 })));
  rmSync(rawPath, { force: true });
}

export async function saveFailureArtifacts(
  reportDirectory: string,
  contexts: readonly LanBrowserContext[],
  server: DemoServerProcess | undefined,
  error: unknown,
  scenarios: readonly LanBrowserScenario[],
  secrets: readonly string[],
): Promise<void> {
  mkdirSync(reportDirectory, { recursive: true });
  const report = {
    error: redact(error instanceof Error ? error.stack ?? error.message : String(error), secrets),
    scenarios: scenarios.map(scenario => ({ ...scenario, ...(scenario.message ? { message: redact(scenario.message, secrets) } : {}) })),
    serverOutput: redact(server?.output.join('') ?? '', secrets),
    artifacts: [] as string[],
  };
  if (server) {
    const serverLog = path.join(reportDirectory, 'server-console.log');
    writeFileSync(serverLog, redact(server.output.join(''), secrets), 'utf8');
    report.artifacts.push(path.basename(serverLog));
  }
  for (const owner of contexts) {
    for (const [index, page] of owner.context.pages().entries()) {
      try {
        await redactPage(page, secrets);
        const screenshot = path.join(reportDirectory, `${owner.name}-${index}.png`);
        await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
        report.artifacts.push(path.basename(screenshot));
      } catch {
        // The page may have already gone away during a process failure.
      }
    }
    if (owner.traceStarted) {
      const rawTrace = path.join(reportDirectory, `${owner.name}.raw.zip`);
      const safeTrace = path.join(reportDirectory, `${owner.name}.trace.zip`);
      try {
        await owner.context.tracing.stop({ path: rawTrace });
        sanitizeTrace(rawTrace, safeTrace, secrets);
        report.artifacts.push(path.basename(safeTrace));
        owner.traceStarted = false;
      } catch {
        try { rmSync(rawTrace, { force: true }); } catch { /* preserve original failure */ }
      }
    }
  }
  writeFileSync(path.join(reportDirectory, 'browser-console.log'), redact(contexts.flatMap(owner => owner.pages).flatMap(page => page.isClosed() ? [] : []).join('\n'), secrets), 'utf8');
  writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function stopTraces(contexts: readonly LanBrowserContext[]): Promise<void> {
  for (const owner of contexts) {
    if (!owner.traceStarted) continue;
    await owner.context.tracing.stop().catch(() => undefined);
    owner.traceStarted = false;
  }
}

export function browserExecutablePresent(): boolean {
  return existsSync(chromium.executablePath());
}

export function baselineDevDbHash(): string | null {
  return fileHash(path.join(repoRoot, 'packages', 'backend', 'prisma', 'dev.db'));
}

export function repoPath(...parts: string[]): string {
  return path.join(repoRoot, ...parts);
}

#!/usr/bin/env node
// @intent Discovery-driven infra: generate docker-compose, thonnas-infra.json, reverse-proxy-routes from component metadata
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPublishedServices,
  extractServiceNames,
  type PublishedService,
  validateHostPortConflicts,
  validatePublishedServicePortConflicts,
} from './lib/compose-discovery.js';
import { normalizeComponentInfra } from './lib/normalize-endpoints.js';
import {
  buildReverseProxyRoutes,
  getDependsOnFromRoutes,
  type ReverseProxyRoute,
} from './lib/reverse-proxy.js';
import { resolveRepoRoot } from './lib/resolve-repo-root.js';
import {
  collectLocalstackServicesFromInfra,
  unionLocalstackServices,
} from './lib/localstack-services.js';
import {
  renderComposeFragment,
  dependsOnServiceNames,
  matchEntriesToNodes,
  serviceNameByInstanceKey,
  type InfraGraph,
} from './lib/graph-compose.js';

interface ComponentMeta {
  name: string;
  componentKey: string;
  /** thonnas.alias, if any -- FEAT-011 instance identity (matches thonnas-cli's buildComponentInstanceKey). */
  alias?: string;
  /** componentKey::alias, or bare componentKey when unaliased. */
  instanceKey: string;
  path: string;
  dependencies: Record<string, string>;
}

interface DiscoveryEntry {
  componentKey: string;
  instanceKey: string;
  composePath: string;
  relativePath: string;
}

/**
 * A graph-rendered entry, plus the *original* template's directory. Compose's `include:` resolves
 * relative paths (env_file, bind-mount volumes, build.context) against the included file's own
 * directory -- but the rendered fragment lives in a shared generated/compose-fragments/ dir (so two
 * aliased instances of one component don't collide on filename), not the component's own directory
 * the template author wrote those relative paths against. `project_directory` on the include entry
 * redirects that resolution back to where the template actually lives, without moving the fragment.
 */
interface RenderedEntry extends DiscoveryEntry {
  templateDir: string;
}

interface DiscoveryResult {
  entries: DiscoveryEntry[];
  warnings: string[];
}

interface CliOptions {
  dryRun: boolean;
  verbose: boolean;
  jsonSummary: string | null;
  env: string | null;
  /** Pre-validated slug for `{deploy-slug}` in hostname patterns (matches Thonnas CLI). */
  deploySlug: string | null;
}

interface RootMetadata {
  projectName: string | null;
  orderedPackages: string[];
}

// ComponentInfra extends compose-discovery shape with derivations for reverse-proxy
interface DerivationDescriptor {
  name: string;
  source?: string;
  sourcePath?: string;
}

type ComponentInfra = import('./lib/compose-discovery.js').ComponentInfra &
  import('./lib/reverse-proxy.js').ComponentInfra;

const ORCHESTRATION_PACKAGE = '@thonnas/infra-docker';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = resolveRepoRoot(__dirname);
const componentRoot = path.join(repoRoot, 'components', 'infra-docker');
const componentsDir = path.join(repoRoot, 'components');
const generatedDir = path.join(componentRoot, 'generated');
const generatedComposePath = path.join(generatedDir, 'docker-compose.generated.yml');
const generatedOverridePath = path.join(generatedDir, 'docker-compose.override.generated.yml');
const generatedDevtoolsPath = path.join(generatedDir, 'docker-compose.devtools.generated.yml');
const generatedInfraPath = path.join(generatedDir, 'thonnas-infra.generated.json');
const generatedRoutesPath = path.join(generatedDir, 'reverse-proxy-routes.txt');
const generatedLocalstackServicesPath = path.join(generatedDir, 'INFRA_LOCALSTACK_SERVICES');
const generatedLocalstackEnvPath = path.join(generatedDir, '.env.localstack');
// @intent FEAT-011: rendered per-instance compose fragments live under generated/, same convention
// (and same gitignore treatment) as every other build-time output in this component.
const generatedFragmentsDir = path.join(generatedDir, 'compose-fragments');

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  try {
    await fs.mkdir(generatedDir, { recursive: true });

    const componentMap = await buildComponentMap();
    const rootMetadata = await readRootMetadata();

    const mainDiscovery = await discoverCompose(componentMap, rootMetadata.orderedPackages, 'docker-compose.yml');
    const overrideDiscovery = await discoverCompose(componentMap, rootMetadata.orderedPackages, 'docker-compose.override.yml');
    const devtoolsDiscovery = await discoverCompose(componentMap, rootMetadata.orderedPackages, 'docker-compose.devtools.yml');

    if (mainDiscovery.entries.length === 0) {
      console.warn('No components depend on infra-docker with docker-compose.yml. Nothing to include.');
    }

    // @intent FEAT-011: render each component's compose *template* (see graph-compose.ts) into a
    // concrete fragment using thonnas-cli's infra-graph.{env}.json -- alias-safe service name,
    // resolved host ports, and depends_on for strategy-resolved dependencies. Only the *rendered*
    // fragments are included in the generated compose file; the original per-component directories
    // (and their thonnas-infra.json) remain the source `infraByKey`/routes/localstack below read from.
    const env = args.env ?? process.env.THONNAS_ENV ?? 'development';
    const graph = await readInfraGraph(env);
    const renderedEntries = await renderGraphDrivenEntries(mainDiscovery.entries, graph);

    await validateComposeFiles(renderedEntries);
    await validateHostPortConflicts(mainDiscovery.entries, (p) => fs.readFile(p, 'utf8'));

    // @intent FEAT-011: same graph-resolved names used to render compose fragments above, now also
    // used for the external/reverse-proxy path -- one resolution, not two independently-alias-blind ones.
    const serviceNames = serviceNameByInstanceKey(graph);

    const infraByKey = await loadComponentInfra(mainDiscovery.entries);
    const publishedServices = buildPublishedServices(mainDiscovery.entries, infraByKey, env, serviceNames);
    validatePublishedServicePortConflicts(mainDiscovery.entries, infraByKey, env, serviceNames);
    const rootDomain = await resolveRootDomain(env);
    const routes = buildReverseProxyRoutes(mainDiscovery.entries, infraByKey, env, serviceNames);

    const localstackServices = await collectInstalledLocalstackServices(componentMap);
    if (!args.dryRun) {
      await writeGeneratedCompose(renderedEntries, rootMetadata.projectName ?? undefined, routes);
      await writeGeneratedOverride(overrideDiscovery.entries);
      await writeGeneratedDevtools(devtoolsDiscovery.entries, rootMetadata.projectName ?? undefined);
      await writeGeneratedInfra(publishedServices);
      await writeGeneratedLocalstackServices(localstackServices);
      await writeGeneratedRoutes(
        routes,
        publishedServices,
        env,
        rootDomain,
        rootMetadata.projectName ?? null,
        args.deploySlug ?? process.env.THONNAS_DEPLOY_SLUG ?? null,
      );
    }

    // Optional debug artifact: not used by other scripts; pass --json-summary <path> to write discovery summary
    if (args.jsonSummary) {
      await fs.writeFile(
        args.jsonSummary,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            main: mainDiscovery.entries,
            override: overrideDiscovery.entries,
            devtools: devtoolsDiscovery.entries,
            warnings: [...mainDiscovery.warnings, ...overrideDiscovery.warnings, ...devtoolsDiscovery.warnings],
          },
          null,
          2,
        ),
      );
    }

    [...mainDiscovery.warnings, ...overrideDiscovery.warnings, ...devtoolsDiscovery.warnings].forEach((w) =>
      console.warn(`WARN: ${w}`),
    );
    console.log(
      args.dryRun
        ? 'Dry run complete (no files written).'
        : `Generated ${path.relative(repoRoot, generatedDir)}/ (compose, thonnas-infra.generated.json, reverse-proxy-routes.txt, INFRA_LOCALSTACK_SERVICES)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`e2e-build failed: ${message}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, verbose: false, jsonSummary: null, env: null, deploySlug: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--env') {
      const next = argv[i + 1];
      if (!next) throw new Error('--env requires a value (e.g. development, beta)');
      opts.env = next;
      i += 1;
    } else if (arg.startsWith('--env=')) {
      opts.env = arg.slice(6);
    } else if (arg === '--deploy-slug') {
      const next = argv[i + 1];
      if (!next) throw new Error('--deploy-slug requires a value (pre-validated deploy slug)');
      opts.deploySlug = next;
      i += 1;
    } else if (arg.startsWith('--deploy-slug=')) {
      opts.deploySlug = arg.slice('--deploy-slug='.length);
    } else if (arg === '--json-summary') {
      // Optional: write discovery summary to a JSON file (debug only; not used by other scripts)
      const next = argv[i + 1];
      if (!next) throw new Error('--json-summary requires a file path');
      opts.jsonSummary = path.resolve(next);
      i += 1;
    }
  }
  return opts;
}

async function loadJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

/** @intent Resolve root domain: THONNAS_ROOT_DOMAIN overrides; local/development default to localhost; then project/config.json per env; then thonnas-package.json thonnas.root_domain */
async function resolveRootDomain(env: string): Promise<string> {
  const override = process.env.THONNAS_ROOT_DOMAIN?.trim();
  if (override) return override;
  if (env === 'local' || env === 'development') return 'localhost';
  const projectConfigPath = path.join(repoRoot, 'project', 'config.json');
  try {
    const config = await loadJson<Record<string, Record<string, unknown>>>(projectConfigPath);
    const domain =
      (typeof config[env]?.THONNAS_ROOT_DOMAIN === 'string' && (config[env].THONNAS_ROOT_DOMAIN as string).trim()) ||
      (typeof config.default?.THONNAS_ROOT_DOMAIN === 'string' && (config.default.THONNAS_ROOT_DOMAIN as string).trim());
    if (domain) return domain;
  } catch {
    // ignore missing or invalid project config
  }
  const rootPkgPath = path.join(repoRoot, 'thonnas-package.json');
  try {
    const pkg = await loadJson<{ thonnas?: { root_domain?: string } }>(rootPkgPath);
    const domain = pkg?.thonnas?.root_domain?.trim();
    return domain ?? 'localhost';
  } catch {
    return 'localhost';
  }
}

// @intent Key by component path so duplicate package names (e.g. api-nest vs api-nest-thonnas-marketplace) don't overwrite.
// Include symlinked directories (e.g. infra-cdk -> baseline-cursor-v3): stat() follows symlinks; entry.isDirectory() is false for symlinks.
async function buildComponentMap(): Promise<Map<string, ComponentMeta>> {
  const entries = await fs.readdir(componentsDir, { withFileTypes: true });
  const map = new Map<string, ComponentMeta>();
  for (const entry of entries) {
    const componentPath = path.join(componentsDir, entry.name);
    try {
      const stat = await fs.stat(componentPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const pkgPath = path.join(componentPath, 'thonnas-package.json');
    try {
      const pkg = await loadJson<{
        name: string;
        thonnas?: { key?: string; alias?: string };
        dependencies?: Record<string, string>;
      }>(pkgPath);
      const componentKey = pkg.thonnas?.key ?? entry.name;
      const alias = pkg.thonnas?.alias?.trim() || undefined;
      map.set(componentPath, {
        name: pkg.name,
        componentKey,
        alias,
        instanceKey: alias ? `${componentKey}::${alias}` : componentKey,
        path: componentPath,
        dependencies: pkg.dependencies ?? {},
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return map;
}

async function readRootMetadata(): Promise<RootMetadata> {
  const rootPkg = await loadJson<{ name?: string; dependencies?: Record<string, string> }>(
    path.join(repoRoot, 'thonnas-package.json'),
  );
  const rawName = typeof rootPkg.name === 'string' ? rootPkg.name.trim() : '';
  return {
    projectName: rawName.length > 0 ? rawName : null,
    orderedPackages: rootPkg.dependencies ? Object.keys(rootPkg.dependencies) : [],
  };
}

function dependsOnOrchestrator(component: ComponentMeta): boolean {
  return (
    component.name !== ORCHESTRATION_PACKAGE &&
    Object.prototype.hasOwnProperty.call(component.dependencies, ORCHESTRATION_PACKAGE)
  );
}

async function discoverCompose(
  componentMap: Map<string, ComponentMeta>,
  orderedPackages: string[],
  composeFileName: string,
): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const selected: ComponentMeta[] = [];
  const seenPaths = new Set<string>();

  for (const pkgName of orderedPackages) {
    for (const component of componentMap.values()) {
      if (component.name === pkgName && dependsOnOrchestrator(component)) {
        selected.push(component);
        seenPaths.add(component.path);
        break;
      }
    }
  }
  const extras = Array.from(componentMap.values()).filter(
    (c) => !seenPaths.has(c.path) && dependsOnOrchestrator(c),
  );
  extras.sort((a, b) => a.componentKey.localeCompare(b.componentKey));
  selected.push(...extras);

  const entries: DiscoveryEntry[] = [];
  for (const component of selected) {
    const composePath = path.join(component.path, composeFileName);
    try {
      await fs.access(composePath);
    } catch {
      warnings.push(
        `Skipping ${component.componentKey}: ${composeFileName} not found (${path.relative(repoRoot, composePath)})`,
      );
      continue;
    }
    entries.push({
      componentKey: component.componentKey,
      instanceKey: component.instanceKey,
      composePath,
      relativePath: toPosix(path.relative(componentRoot, composePath)),
    });
  }
  return { entries, warnings };
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function validateComposeFiles(entries: DiscoveryEntry[]): Promise<void> {
  const serviceOwners = new Map<string, string>();
  for (const entry of entries) {
    const content = await fs.readFile(entry.composePath, 'utf8');
    const services = extractServiceNames(content);
    if (services.length === 0) {
      throw new Error(`Compose file for ${entry.componentKey} does not declare any services.`);
    }
    for (const name of services) {
      if (serviceOwners.has(name)) {
        throw new Error(
          `Service "${name}" defined in both ${serviceOwners.get(name)} and ${entry.componentKey}. Rename or namespace services.`,
        );
      }
      serviceOwners.set(name, entry.componentKey);
    }
  }
}

/** @intent Read extras from every installed component, even without a compose file */
async function collectInstalledLocalstackServices(
  componentMap: Map<string, ComponentMeta>,
): Promise<string> {
  const contributed: string[] = [];
  for (const component of componentMap.values()) {
    const infraPath = path.join(component.path, 'thonnas-infra.json');
    try {
      const raw = await loadJson<unknown>(infraPath);
      contributed.push(...collectLocalstackServicesFromInfra(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return unionLocalstackServices(contributed);
}

// @intent Write compose-interpolated SERVICES union under generated/
async function writeGeneratedLocalstackServices(services: string): Promise<void> {
  await fs.writeFile(generatedLocalstackServicesPath, `${services}\n`);
  await fs.writeFile(generatedLocalstackEnvPath, `INFRA_LOCALSTACK_SERVICES=${services}\n`);
}

async function loadComponentInfra(entries: DiscoveryEntry[]): Promise<Map<string, ComponentInfra>> {
  const map = new Map<string, ComponentInfra>();
  for (const entry of entries) {
    const infraPath = path.join(path.dirname(entry.composePath), 'thonnas-infra.json');
    try {
      const raw = await loadJson<Record<string, unknown>>(infraPath);
      const normalized = normalizeComponentInfra(raw) as ComponentInfra;
      map.set(entry.componentKey, normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return map;
}

// @intent FEAT-011: load thonnas-cli's generated graph. This build fails closed (a clear error, not
// a silent fallback to the pre-FEAT-011 raw-include behavior) when it's missing -- run
// `thonnas infra graph --env <env>` first, same fail-closed contract as config resolve/infra-cdk.
async function readInfraGraph(env: string): Promise<InfraGraph> {
  const graphPath = path.join(repoRoot, 'project', 'generated', `infra-graph.${env}.json`);
  try {
    return await loadJson<InfraGraph>(graphPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${path.relative(repoRoot, graphPath)} not found. Run "thonnas infra graph --env ${env}" before ` +
          'building infra-docker\'s compose output.',
      );
    }
    throw error;
  }
}

/**
 * Render each discovered component's compose *template* against its graph node, writing the
 * result under generated/compose-fragments/ and returning entries pointing at those rendered
 * files instead of the original component-authored templates.
 */
async function renderGraphDrivenEntries(entries: DiscoveryEntry[], graph: InfraGraph): Promise<RenderedEntry[]> {
  await fs.mkdir(generatedFragmentsDir, { recursive: true });
  const matched = matchEntriesToNodes(entries, graph);

  const rendered: RenderedEntry[] = [];
  for (const { entry, node } of matched) {
    const templateContent = await fs.readFile(entry.composePath, 'utf8');
    const dependsOn = dependsOnServiceNames(graph, node);
    const renderedContent = renderComposeFragment(templateContent, node, dependsOn);

    const fragmentPath = path.join(generatedFragmentsDir, `${sanitizeFragmentName(entry.instanceKey)}.yml`);
    await fs.writeFile(fragmentPath, renderedContent);
    rendered.push({
      componentKey: entry.componentKey,
      instanceKey: entry.instanceKey,
      composePath: fragmentPath,
      relativePath: toPosix(path.relative(componentRoot, fragmentPath)),
      templateDir: path.dirname(entry.composePath),
    });
  }
  return rendered;
}

function sanitizeFragmentName(instanceKey: string): string {
  return instanceKey.replace(/::/g, '-');
}

async function writeGeneratedCompose(
  entries: RenderedEntry[],
  composeName: string | undefined,
  routes: ReverseProxyRoute[],
): Promise<void> {
  const includeBlock =
    entries.length === 0
      ? 'include: []\n\n'
      : `include:\n${entries
          .map(
            (e) =>
              `  - path: ${toPosix(path.relative(generatedDir, e.composePath))}\n` +
              `    project_directory: ${toPosix(path.relative(generatedDir, e.templateDir))}`,
          )
          .join('\n')}\n\n`;
  const nameLine = composeName ? `name: ${composeName}\n\n` : '';
  const dependsOnServices = getDependsOnFromRoutes(routes);
  const dependsOnBlock =
    dependsOnServices.length === 0
      ? ''
      : `    depends_on:\n${dependsOnServices.map((s) => `      - ${s}`).join('\n')}\n`;
  // Routes file: host|upstream|websocket per line (literal hostnames from e2e-build; no runtime substitution)
  const routesVolume = '    volumes:\n      - ./reverse-proxy-routes.txt:/opt/thonnas-routes/routes.txt:ro\n';
  const reverseProxyContext = '..';
  const reverseProxyDockerfile = 'reverse-proxy/Dockerfile';
  const content = `# Generated by e2e-build - do not edit
${nameLine}${includeBlock}services:
  infra-docker-reverse-proxy:
    build:
      context: ${reverseProxyContext}
      dockerfile: ${reverseProxyDockerfile}
    restart: unless-stopped
    ports:
      - "\${REVERSE_PROXY_HOST_PORT:-80}:80"
    environment:
      INFRA_DOCKER_PROXY_MAX_BODY_SIZE: \${INFRA_DOCKER_PROXY_MAX_BODY_SIZE:-500m}
${dependsOnBlock}${routesVolume}    networks:
      - thonnas-network

networks:
  thonnas-network:
    external: true
`;
  await fs.writeFile(generatedComposePath, content);
}

async function writeGeneratedOverride(entries: DiscoveryEntry[]): Promise<void> {
  const includeBlock =
    entries.length === 0
      ? 'include: []\n'
      : `include:\n${entries.map((e) => `  - path: ${toPosix(path.relative(generatedDir, e.composePath))}`).join('\n')}\n`;
  const content = `# Generated by e2e-build - do not edit\n${includeBlock}`;
  await fs.writeFile(generatedOverridePath, content);
}

// @intent Paths in generated file are relative to generated/; shadow only this component's node_modules in devtools-node
async function writeGeneratedDevtools(entries: DiscoveryEntry[], projectName?: string): Promise<void> {
  const nameLine = projectName ? `name: ${projectName}\n\n` : '';
  const includeBlock =
    entries.length === 0
      ? 'include: []\n'
      : `include:\n${entries.map((e) => `  - path: ${toPosix(path.relative(generatedDir, e.composePath))}`).join('\n')}\n`;

  const infraRel = toPosix(path.relative(repoRoot, componentRoot));
  const devtoolsNodeVolumes = [
    '    - ../../../:/workspace',
    '    - devtools-node-modules:/workspace/node_modules',
    '    - devtools-pnpm-store:/root/.pnpm-store',
    `    - /workspace/${infraRel}/node_modules`,
  ];
  const devtoolsNodeBlock = `
services:
  devtools-node:
    image: node:20-alpine
    working_dir: /workspace
    volumes:
${devtoolsNodeVolumes.join('\n')}
    environment:
      - NODE_ENV=development
    command: ["tail", "-f", "/dev/null"]
    labels:
      com.thonnas.component: "devtools-node"
      com.thonnas.component-type: "devtools"
    networks:
      - thonnas-network
`;

  const content = `# Generated by e2e-build - do not edit
${nameLine}${includeBlock}${devtoolsNodeBlock}`;
  await fs.writeFile(generatedDevtoolsPath, content);
}

// @intent Write only discovered publishedServices; consumers merge with base thonnas-infra.json
async function writeGeneratedInfra(publishedServices: PublishedService[]): Promise<void> {
  const payload = { publishedServices };
  await fs.writeFile(generatedInfraPath, JSON.stringify(payload, null, 2));
}

// @intent For prod/production, omit env and deploy-slug from hostnames so e.g. {deploy-slug}.{env}.api.{rootDomain} → api.{rootDomain}
function getEnvForHost(env: string): string {
  const lower = env.toLowerCase();
  return lower === 'prod' || lower === 'production' ? '' : env;
}

// @intent Compute value for {deploy-slug} placeholder; slug is CLI-pre-validated
function computeDeploySlugPrefix(env: string, deploySlug: string | null | undefined): string {
  const lowerEnv = env.toLowerCase();
  if (lowerEnv === 'prod' || lowerEnv === 'production') return '';
  if (!deploySlug || !deploySlug.trim()) return '';
  const s = deploySlug.trim().toLowerCase();
  if (s === lowerEnv) return '';
  return s;
}

// @intent After token replacement: strip leading period and collapse multiple periods to one
function postProcessHost(value: string): string {
  if (value == null || value === '') return value;
  return value.replace(/^\.+/, '').replace(/\.\.+/g, '.');
}

/** @intent Resolve hostname from pattern using deploy-slug/env/rootDomain; used for nginx-ready routes file. */
function resolveHostnamePattern(
  pattern: string,
  env: string,
  rootDomain: string,
  componentKey: string,
  rawDeploySlug: string | null | undefined,
): string {
  const slugPrefix = computeDeploySlugPrefix(env, rawDeploySlug);
  const envValue = getEnvForHost(env);
  const raw = pattern
    .replace(/\{deploy-slug\}/g, slugPrefix)
    .replace(/\{env\}/g, envValue)
    .replace(/\{rootDomain\}/g, rootDomain)
    .replace(/\{component\}/g, componentKey);
  return postProcessHost(raw);
}

/** @intent Slug for hostname: strip @, replace / with -, trim; avoid conflicting localhost when rootDomain is localhost. */
function slugForHostname(projectName: string | null): string {
  if (!projectName || !projectName.trim()) return 'app';
  return projectName
    .replace(/@/g, '')
    .replace(/\//g, '-')
    .trim()
    .toLowerCase();
}

/** @intent One line per route: host|upstream|websocket. Literal hostnames so nginx needs no env lookup or substitution. */
async function writeGeneratedRoutes(
  routes: ReverseProxyRoute[],
  publishedServices: PublishedService[],
  env: string,
  rootDomain: string,
  projectName: string | null,
  rawDeploySlug: string | null,
): Promise<void> {
  const serviceByName = new Map(publishedServices.map((s) => [s.name, s]));
  const projectSlug = slugForHostname(projectName);
  const lines = routes.map((r) => {
    const serviceName = r.upstream.split(':')[0];
    const service = serviceByName.get(serviceName);
    const pattern = service?.hostnamePattern ?? `{env}.${serviceName}.{rootDomain}`;
    // @intent Always resolve pattern so routes file has literal hostnames (defaultHost from infra may be a template)
    let host = resolveHostnamePattern(
      r.defaultHost ?? pattern,
      env,
      rootDomain,
      r.componentKey,
      rawDeploySlug,
    );
    // @intent When host is exactly localhost, use project-component.localhost to avoid nginx conflicting server_name
    if (host === 'localhost') {
      host = `${projectSlug}-${r.componentKey}.localhost`;
    }
    return `${host}|${r.upstream}|${r.websocket}`;
  });
  const content = '# Generated by e2e-build - do not edit\n' + lines.join('\n') + '\n';
  await fs.writeFile(generatedRoutesPath, content);
}

void main();



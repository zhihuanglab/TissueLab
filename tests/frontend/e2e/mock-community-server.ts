/**
 * A stand-in for the hosted TissueLab community (Ctrl Service) for the e2e run.
 *
 * Started in-process by `global-setup.ts` and handed to the renderer as
 * `PUBLIC_COMMUNITY_API_ENDPOINT`. It speaks the Ctrl Service envelope
 * (`{code, message, data}` on HTTP 200) for the routes the Community page,
 * the cards and the workflow presets read, and — like the real server — it
 * refuses anything without an `Authorization: Bearer …` header with
 * `{code: 401, message: "No authentication token provided."}`.
 *
 * `GET /__e2e/requests` returns what it received (method, path, bearer token)
 * so a test can assert that the Firebase token reached the community.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCommunityRequest {
  method: string;
  path: string;
  authorization: string | null;
}

const OWNER_A = 'e2e-author-alpha';
const OWNER_B = 'e2e-author-beta';

export const MOCK_AUTHORS: Record<string, { displayName: string; avatarUrl: string | null }> = {
  [OWNER_A]: { displayName: 'Alpha Pathologist', avatarUrl: null },
  [OWNER_B]: { displayName: 'Beta Researcher', avatarUrl: null },
};

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export const MOCK_CLASSIFIERS = [
  {
    id: 'uploaded-1700000000001',
    ownerId: OWNER_A,
    fileName: 'tumor_vs_stroma.tlcls',
    localPath: 'classifiers/tumor_vs_stroma.tlcls',
    title: 'Tumor vs Stroma (E2E)',
    description: 'Per-cell classifier separating tumor from stroma on H&E.',
    factory: 'nuclei_classification',
    model: 'NuClass',
    downloadLink: 'e2e-link-1',
    tags: ['Pathology'],
    classesCount: 2,
    fileSize: 245_760,
    isPublic: true,
    createdAt: iso(3),
    updatedAt: iso(1),
    stats: { classes: 2, downloads: 12, size: 245_760, stars: 4 },
  },
  {
    id: 'uploaded-1700000000002',
    ownerId: OWNER_B,
    fileName: 'lymphocyte_panel.tlcls',
    localPath: 'classifiers/lymphocyte_panel.tlcls',
    title: 'Lymphocyte panel (E2E)',
    description: 'Five-class immune panel for breast TME review.',
    factory: 'nuclei_classification',
    model: 'NuClass',
    downloadLink: 'e2e-link-2',
    tags: ['Pathology', 'Spatial Transcriptomics'],
    classesCount: 5,
    fileSize: 1_048_576,
    isPublic: true,
    createdAt: iso(10),
    updatedAt: iso(2),
    stats: { classes: 5, downloads: 3, size: 1_048_576, stars: 1 },
  },
];

export const MOCK_MODELS = [
  {
    id: 'uploaded-1700000000101',
    ownerId: OWNER_A,
    fileName: 'stardist_fluo.zip',
    localPath: 'models/stardist_fluo.zip',
    title: 'StarDist fluorescence weights (E2E)',
    description: 'Fine-tuned StarDist weights for DAPI nuclei.',
    factory: 'cell_segmentation',
    model: 'StarDist',
    downloadLink: 'e2e-model-link-1',
    tags: ['Cell Segmentation + Embedding', 'StarDist', 'Pathology'],
    fileSize: 52_428_800,
    isPublic: true,
    createdAt: iso(5),
    updatedAt: iso(4),
    stats: { downloads: 7, size: 52_428_800, stars: 2 },
  },
];

export const MOCK_WORKFLOWS = [
  {
    id: 'wf-uploaded-1700000000201',
    name: 'E2E nuclei count workflow',
    description: 'Segment nuclei with StarDist, then classify with NuClass.',
    author: 'Alpha Pathologist',
    ownerId: OWNER_A,
    savedAt: iso(2),
    nodes: [
      { id: '__start__', kind: 'start', x: 140, y: 24 },
      { id: 'e2e-seg', kind: 'model', modelId: 'StarDist', x: 140, y: 120 },
      { id: 'e2e-clf', kind: 'model', modelId: 'NuClass', x: 140, y: 220 },
      { id: '__end__', kind: 'end', x: 140, y: 320 },
    ],
    connections: [
      { id: 'e2e-c1', fromId: '__start__', toId: 'e2e-seg', fromPort: 'bottom', toPort: 'top' },
      { id: 'e2e-c2', fromId: 'e2e-seg', toId: 'e2e-clf', fromPort: 'bottom', toPort: 'top' },
      { id: 'e2e-c3', fromId: 'e2e-clf', toId: '__end__', fromPort: 'bottom', toPort: 'top' },
    ],
    panelStates: {},
    chatMessages: [],
    selectedId: null,
    tags: ['nuclei'],
    isPublic: true,
  },
];

export interface MockCommunityServer {
  url: string;
  requests: RecordedCommunityRequest[];
  close: () => Promise<void>;
}

const envelope = (data: unknown, code = 0, message = 'ok') => ({ code, message, data, request_id: 'e2e' });

export function startMockCommunityServer(): Promise<MockCommunityServer> {
  const requests: RecordedCommunityRequest[] = [];
  const starred = new Set<string>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api(?=\/)/, '');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, X-Device-Id, X-Instance-ID',
      'access-control-max-age': '600',
    };
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
      res.end(JSON.stringify(body));
    };

    if (method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Test-only introspection, no auth.
    if (path === '/__e2e/requests') return send(200, requests);
    if (path === '/__e2e/reset') {
      requests.length = 0;
      starred.clear();
      return send(200, { ok: true });
    }

    const authorization = req.headers.authorization ?? null;
    requests.push({ method, path, authorization });

    // One-time download URLs carry the token in the path, like the real server.
    let m = /^\/community\/v1\/(classifiers|models)\/download\/([^/]+)$/.exec(path);
    if (m) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '16', ...cors });
      res.end(Buffer.from('E2E-FAKE-PAYLOAD'));
      return;
    }

    if (!authorization || !/^Bearer\s+\S+/.test(authorization)) {
      return send(200, envelope(null, 401, 'No authentication token provided.'));
    }

    // Body is read only for the routes that need it; none of the mocked ones do.
    req.resume();

    if (method === 'GET' && path === '/community/v1/classifiers/public') {
      return send(200, envelope({ success: true, classifiers: MOCK_CLASSIFIERS, total: MOCK_CLASSIFIERS.length, offset: 0, limit: 100 }));
    }
    if (method === 'GET' && path === '/community/v1/classifiers') {
      return send(200, envelope({ success: true, classifiers: [], total: 0 }));
    }
    if (method === 'GET' && path === '/community/v1/models/public') {
      return send(200, envelope({ success: true, models: MOCK_MODELS, total: MOCK_MODELS.length, offset: 0, limit: 100 }));
    }
    if (method === 'GET' && path === '/community/v1/workflows/public') {
      return send(200, envelope({ success: true, workflows: MOCK_WORKFLOWS, total: MOCK_WORKFLOWS.length, offset: 0, limit: 100 }));
    }
    m = /^\/community\/v1\/workflows\/referencing\/([^/]+)$/.exec(path);
    if (m) return send(200, envelope({ success: true, workflows: [], total: 0 }));

    m = /^\/community\/v1\/users\/([^/]+)\/public-profile$/.exec(path);
    if (m) {
      const uid = decodeURIComponent(m[1]);
      const author = MOCK_AUTHORS[uid];
      if (!author) return send(200, envelope(null, 404, 'User not found'));
      return send(200, envelope({ uid, ...author }), { 'cache-control': 'public, max-age=300' });
    }
    m = /^\/users\/v1\/public_profile\/([^/]+)$/.exec(path);
    if (m) {
      const uid = decodeURIComponent(m[1]);
      const author = MOCK_AUTHORS[uid];
      if (!author) return send(200, envelope(null, 404, 'User not found'));
      return send(200, envelope({ found: true, user_id: uid, preferred_name: author.displayName, avatar_url: author.avatarUrl, registered_at: Date.now() - 30 * 86_400_000 }));
    }

    m = /^\/community\/v1\/(classifiers|models)\/([^/]+)(?:\/(download-link|download-count|star))?$/.exec(path);
    if (m) {
      const kind = m[1];
      const id = decodeURIComponent(m[2]);
      const action = m[3];
      const list: Array<{ id: string; stats?: { stars?: number; downloads?: number } }> = kind === 'classifiers' ? MOCK_CLASSIFIERS : MOCK_MODELS;
      const item = list.find((x) => x.id === id);
      if (!item) return send(200, envelope(null, 404, `${kind === 'classifiers' ? 'Classifier' : 'Model'} not found`));
      const starKey = `${kind}:${id}`;
      const starCount = (item.stats?.stars ?? 0) + (starred.has(starKey) ? 1 : 0);
      if (!action && method === 'GET') {
        const detail = { star_count: starCount, is_starred: starred.has(starKey), download_count: item.stats?.downloads ?? 0 };
        return send(200, envelope(kind === 'classifiers' ? { success: true, classifier: item, ...detail } : { success: true, model: item, ...detail }));
      }
      if (!action && method === 'DELETE') return send(200, envelope({ success: true, message: 'deleted' }));
      if (action === 'download-link' && method === 'POST') {
        return send(200, envelope({ success: true, download_token: `e2e-token-${id}`, file_name: (item as { fileName?: string }).fileName || '' }));
      }
      if (action === 'download-count' && method === 'POST') return send(200, envelope({ success: true }));
      if (action === 'star') {
        if (method === 'POST') starred.add(starKey);
        if (method === 'DELETE') starred.delete(starKey);
        const next = (item.stats?.stars ?? 0) + (starred.has(starKey) ? 1 : 0);
        return send(200, envelope({ success: true, starCount: next, is_starred: starred.has(starKey) }));
      }
    }

    return send(200, envelope(null, 404, `E2E mock: no handler for ${method} ${path}`));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

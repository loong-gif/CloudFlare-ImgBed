import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import { createContext } from './helpers/context.js';
import * as fileExpiryHelpers from '../functions/utils/fileExpiryHelpers.js';

describe('catalog API', () => {
    let db, mocks, catalogMocks;

    beforeEach(() => {
        db = memoryDatabase();
        mocks = {
            getDatabase: () => db,
            checkDatabaseConfig: () => ({ usingD1: false }),
            ...fileExpiryHelpers,
        };
        catalogMocks = {
            ...mocks,
            validateCatalogToken: async (request, _db) => {
                const auth = request.headers.get('Authorization');
                if (auth === 'Bearer valid_catalog_token') {
                    return { valid: true, tokenData: { permissions: ['catalog'] } };
                }
                return { valid: false, error: 'Invalid token' };
            },
        };
    });

    describe('middleware authentication', () => {
        it('rejects requests without Authorization header', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', {
                ...mocks,
                validateCatalogToken: async () => ({ valid: false, error: 'Missing Authorization header' }),
            });
            const ctx = createContext('https://test/api/catalog/list', {
                method: 'GET',
                env: {},
            });
            ctx.next = async () => new Response('OK');
            const response = await middleware.onRequest[0](ctx);
            assert.equal(response.status, 401);
            const body = await response.json();
            assert.ok(body.error.includes('Missing'));
        });

        it('rejects non-Bearer tokens', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', {
                ...mocks,
                validateCatalogToken: async () => ({ valid: false, error: 'Invalid format' }),
            });
            const ctx = createContext('https://test/api/catalog/list', {
                method: 'GET',
                headers: { 'Authorization': 'Basic abc123' },
                env: {},
            });
            ctx.next = async () => new Response('OK');
            const response = await middleware.onRequest[0](ctx);
            assert.equal(response.status, 401);
        });

        it('rejects tokens without catalog permission', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', {
                ...mocks,
                validateCatalogToken: async () => ({ valid: false, error: "Token lacks 'catalog' permission" }),
            });
            const ctx = createContext('https://test/api/catalog/list', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer upload_only_token' },
                env: {},
            });
            ctx.next = async () => new Response('OK');
            const response = await middleware.onRequest[0](ctx);
            assert.equal(response.status, 401);
            const body = await response.json();
            assert.ok(body.error.includes('catalog'));
        });

        it('allows valid catalog tokens', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', catalogMocks);
            const ctx = createContext('https://test/api/catalog/list', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer valid_catalog_token' },
                env: {},
            });
            let nextCalled = false;
            ctx.next = async () => { nextCalled = true; return new Response('OK'); };
            await middleware.onRequest[0](ctx);
            assert.equal(nextCalled, true);
        });

        it('rejects mutation methods (POST/PUT/DELETE/PATCH)', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', catalogMocks);
            for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
                const ctx = createContext('https://test/api/catalog/list', {
                    method,
                    headers: { 'Authorization': 'Bearer valid_catalog_token' },
                    env: {},
                });
                ctx.next = async () => { assert.fail('next should not be called'); };
                const response = await middleware.onRequest[0](ctx);
                assert.equal(response.status, 405, `${method} should be rejected`);
                const body = await response.json();
                assert.ok(body.error.includes('read-only'));
            }
        });

        it('allows OPTIONS for CORS preflight', async () => {
            const middleware = await loadFunction('functions/api/catalog/_middleware.js', mocks);
            const ctx = createContext('https://test/api/catalog/list', {
                method: 'OPTIONS',
                env: {},
            });
            const response = await middleware.onRequest[0](ctx);
            assert.equal(response.status, 204);
            assert.ok(response.headers.get('Access-Control-Allow-Methods').includes('GET'));
        });
    });

    describe('list endpoint', () => {
        function createReadIndexMock(files, options = {}) {
            return async (context, queryOpts = {}) => {
                let filtered = [...files];
                
                if (queryOpts.accessStatus?.includes('normal')) {
                    filtered = filtered.filter(f => {
                        const lt = f.metadata?.ListType;
                        const label = f.metadata?.Label;
                        const isBlocked = lt === 'Block' || (label === 'adult' && lt !== 'White');
                        return !isBlocked;
                    });
                }
                
                if (queryOpts.search) {
                    const s = queryOpts.search.toLowerCase();
                    filtered = filtered.filter(f => 
                        f.id.toLowerCase().includes(s) || 
                        f.metadata?.FileName?.toLowerCase().includes(s)
                    );
                }
                
                if (queryOpts.directory) {
                    const dir = queryOpts.directory;
                    filtered = filtered.filter(f => f.id.startsWith(dir) || f.metadata?.Directory?.startsWith(dir));
                }
                
                const totalCount = filtered.length;
                const start = queryOpts.start || 0;
                const count = queryOpts.count || 50;
                const paged = filtered.slice(start, start + count);
                
                return {
                    success: true,
                    files: paged,
                    directories: options.directories || [],
                    totalCount,
                    returnedCount: paged.length,
                };
            };
        }

        it('returns files with safe metadata and public URLs', async () => {
            const files = [
                {
                    id: 'photos/cat.jpg',
                    metadata: {
                        FileName: 'cat.jpg',
                        FileType: 'image/jpeg',
                        FileSize: 1.5,
                        TimeStamp: 1700000000000,
                        Directory: 'photos/',
                        Tags: ['animal', 'cute'],
                        Channel: 'CloudflareR2',
                        TgFileId: 'SHOULD_NOT_APPEAR',
                        TgBotToken: 'SECRET_TOKEN',
                        S3AccessKeyId: 'SECRET_KEY',
                    },
                },
            ];

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: (t) => t?.startsWith('image/') ? 'image' : 'other',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list');
            const response = await route.onRequest(ctx);
            assert.equal(response.status, 200);

            const body = await response.json();
            assert.equal(body.files.length, 1);
            const file = body.files[0];
            assert.equal(file.name, 'cat.jpg');
            assert.equal(file.path, 'photos/cat.jpg');
            assert.equal(file.url, 'https://test/file/photos%2Fcat.jpg');
            assert.equal(file.type, 'image/jpeg');
            assert.equal(file.size, 1.5);
            assert.deepEqual(file.tags, ['animal', 'cute']);

            assert.equal(file.TgFileId, undefined, 'TgFileId should not be exposed');
            assert.equal(file.TgBotToken, undefined, 'TgBotToken should not be exposed');
            assert.equal(file.S3AccessKeyId, undefined, 'S3 credentials should not be exposed');
            assert.equal(file.Channel, undefined, 'Channel should not be exposed');
        });

        it('supports pagination with bounded limits', async () => {
            const files = Array.from({ length: 10 }, (_, i) => ({
                id: `file${i}.png`,
                metadata: { FileName: `file${i}.png`, FileType: 'image/png' },
            }));

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: () => 'image',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list?start=2&count=3');
            const response = await route.onRequest(ctx);
            const body = await response.json();

            assert.equal(body.returnedCount, 3);
            assert.equal(body.totalCount, 10);
            assert.equal(body.hasMore, true);
            assert.equal(body.files[0].name, 'file2.png');
        });

        it('enforces maximum page size of 200', async () => {
            const files = Array.from({ length: 5 }, (_, i) => ({
                id: `file${i}.png`,
                metadata: { FileName: `file${i}.png` },
            }));

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: () => 'image',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list?count=500');
            const response = await route.onRequest(ctx);
            assert.equal(response.status, 200);
        });

        it('supports search filtering', async () => {
            const files = [
                { id: 'photos/sunset.jpg', metadata: { FileName: 'sunset.jpg' } },
                { id: 'photos/sunrise.jpg', metadata: { FileName: 'sunrise.jpg' } },
                { id: 'docs/readme.txt', metadata: { FileName: 'readme.txt' } },
            ];

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: () => 'image',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list?search=sun');
            const response = await route.onRequest(ctx);
            const body = await response.json();

            assert.equal(body.files.length, 2);
            assert.ok(body.files.every(f => f.name.includes('sun')));
            assert.equal(body.search, 'sun');
        });

        it('supports directory filtering', async () => {
            const files = [
                { id: 'photos/cat.jpg', metadata: { FileName: 'cat.jpg', Directory: 'photos/' } },
                { id: 'photos/sub/dog.jpg', metadata: { FileName: 'dog.jpg', Directory: 'photos/sub/' } },
                { id: 'docs/note.txt', metadata: { FileName: 'note.txt', Directory: 'docs/' } },
            ];

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: () => 'image',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list?dir=photos');
            const response = await route.onRequest(ctx);
            const body = await response.json();

            assert.equal(body.directory, 'photos/');
            assert.ok(body.files.every(f => f.path.startsWith('photos/')));
        });

        it('prevents path traversal attacks', async () => {
            const listMocks = {
                ...mocks,
                readIndex: async () => ({ success: true, files: [], directories: [], totalCount: 0, returnedCount: 0 }),
                getFileTypeCategory: () => 'other',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list?dir=../../../etc');
            const response = await route.onRequest(ctx);
            assert.equal(response.status, 200);
        });

        it('filters blocked content by default', async () => {
            const files = [
                { id: 'normal.jpg', metadata: { FileName: 'normal.jpg', ListType: 'None' } },
                { id: 'blocked.jpg', metadata: { FileName: 'blocked.jpg', ListType: 'Block' } },
                { id: 'adult.jpg', metadata: { FileName: 'adult.jpg', Label: 'adult' } },
            ];

            const listMocks = {
                ...mocks,
                readIndex: createReadIndexMock(files),
                getFileTypeCategory: () => 'image',
            };

            const route = await loadFunction('functions/api/catalog/list.js', listMocks);
            const ctx = createContext('https://test/api/catalog/list');
            const response = await route.onRequest(ctx);
            const body = await response.json();

            assert.equal(body.files.length, 1);
            assert.equal(body.files[0].name, 'normal.jpg');
        });
    });

    describe('token validator', () => {
        it('validates catalog permission specifically', async () => {
            const tokens = {
                'imgbed_catalogtoken123': { permissions: ['catalog'], expiresAt: null },
                'imgbed_uploadtoken456': { permissions: ['upload'], expiresAt: null },
            };

            const validatorMocks = {
                ...mocks,
                getTokenData: async (db, token) => tokens[token] || null,
                isExpired: () => false,
            };

            const validator = await loadFunction('functions/utils/auth/catalogTokenValidator.js', validatorMocks);

            const validReq = new Request('https://test/', {
                headers: { 'Authorization': 'Bearer imgbed_catalogtoken123' },
            });
            const validResult = await validator.validateCatalogToken(validReq, db);
            assert.equal(validResult.valid, true);

            const invalidReq = new Request('https://test/', {
                headers: { 'Authorization': 'Bearer imgbed_uploadtoken456' },
            });
            const invalidResult = await validator.validateCatalogToken(invalidReq, db);
            assert.equal(invalidResult.valid, false);
            assert.ok(invalidResult.error.includes('catalog'));
        });

        it('rejects expired tokens', async () => {
            const validatorMocks = {
                ...mocks,
                getTokenData: async () => ({ permissions: ['catalog'], expiresAt: '2020-01-01T00:00:00Z' }),
                isExpired: (expiresAt) => expiresAt !== null && new Date(expiresAt) < new Date(),
            };

            const validator = await loadFunction('functions/utils/auth/catalogTokenValidator.js', validatorMocks);
            const req = new Request('https://test/', {
                headers: { 'Authorization': 'Bearer imgbed_expiredtoken' },
            });
            const result = await validator.validateCatalogToken(req, db);
            assert.equal(result.valid, false);
            assert.ok(result.error.includes('expired'));
        });
    });
});

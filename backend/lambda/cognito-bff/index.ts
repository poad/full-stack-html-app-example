/*
 * Amazon Cognito を使った BFF Lambda ハンドラ (TypeScript).
 *
 * エンドポイント:
 *   GET /auth/login      - Cognito ホスト型UI (ログイン/サインアップ/パスキー/MFA) へリダイレクト
 *   GET /auth/callback   - 認可コードを Cognito トークンエンドポイントで交換し、セッション Cookie を発行
 *   GET /auth/logout     - セッション削除 + Cognito サインアウト
 *   GET /auth/me         - セッション検証とユーザ情報の返却
 *   GET|POST|PUT|PATCH|DELETE /api/todos - DynamoDB TODO CRUD (セッション必須)
 *   GET|POST|PUT|PATCH|DELETE /api/*    - 外部バックエンドプロキシ (セッション必須)
 *
 * セッションは AES-256-GCM 暗号化 + HMAC-SHA256 署名の Cookie (bff_session) で保持し、
 * セッション鍵は SSM Parameter Store (SecureString) から Lambda 実行時に取得します。
 * Cognito アクセストークン (JWT) は User Pool の JWKS で RS256 検証します。
 *
 * AWS SDK for JavaScript v3 を使用します。
 * Node.js 18 以降の Lambda ランタイムには v3 がプリインストールされているため、
 * 追加のバンドルは不要です (必要なパッケージ:
 *   @aws-sdk/client-ssm, @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb)。
 */

import * as crypto from 'crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const TODOS_TABLE_NAME = process.env.TODOS_TABLE_NAME || '';

const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN || ''; // 例: xxx.auth.region.amazoncognito.com
const COGNITO_REGION = process.env.COGNITO_REGION || '';
const SESSION_SECRET_PARAM_NAME = process.env.SESSION_SECRET_PARAM_NAME || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

const COGNITO_ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;
const COGNITO_JWKS_URL = `${COGNITO_ISSUER}/.well-known/jwks.json`;
const COGNITO_TOKEN_URL = `https://${COGNITO_DOMAIN}/oauth2/token`;
const COGNITO_LOGIN_URL = `https://${COGNITO_DOMAIN}/login`;
const COGNITO_LOGOUT_URL = `https://${COGNITO_DOMAIN}/logout`;

const COOKIE_NAME = 'bff_session';
const SESSION_AAD = Buffer.from('cognito-bff-session', 'utf8');

// SSM から取得した値 (初回ハンドラ実行時に遅延初期化)
let sessionSecret = '';
let secretsLoaded = false;

// セッションの暗号化/署名鍵 (32バイト)
let sessionKey: Buffer | null = null;

async function loadSecrets(): Promise<void> {
  if (secretsLoaded) return;

  if (SESSION_SECRET_PARAM_NAME) {
    const res = await ssmClient.send(
      new GetParameterCommand({ Name: SESSION_SECRET_PARAM_NAME, WithDecryption: true }),
    );
    sessionSecret = res.Parameter?.Value ?? '';
  }
  sessionKey = crypto
    .createHash('sha256')
    .update(sessionSecret || '')
    .digest();
  secretsLoaded = true;
}

async function ensureSecretsLoaded(): Promise<void> {
  if (!secretsLoaded) await loadSecrets();
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/*
 * セッションペイロードを暗号化+署名して Cookie 値を生成.
 * 構成: base64url(iv || ciphertext || authTag) . base64url(hmac)
 */
function sealSession(payload: unknown): string {
  if (!sessionKey) throw new Error('secrets not loaded');
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  cipher.setAAD(SESSION_AAD);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([iv, encrypted, tag]);
  const mac = crypto.createHmac('sha256', sessionKey).update(ciphertext).digest();
  return `${base64url(ciphertext)}.${base64url(mac)}`;
}

/*
 * 署名検証 + 復号. 改竄や期限外は null を返す.
 */
function openSession(value: string): {
  accessToken?: string;
  idToken?: string;
  user?: unknown;
  expiresAt?: number;
  sub?: string;
} | null {
  if (!sessionKey) throw new Error('secrets not loaded');
  try {
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const ciphertext = Buffer.from(value.slice(0, dot), 'base64url');
    const mac = Buffer.from(value.slice(dot + 1), 'base64url');
    if (!ciphertext || ciphertext.length < 12 + 16) return null;
    if (mac.length !== 32) return null;
    const expected = crypto.createHmac('sha256', sessionKey).update(ciphertext).digest();
    if (!crypto.timingSafeEqual(expected, mac)) return null;
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(12, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(SESSION_AAD);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as {
      accessToken?: string;
      idToken?: string;
      user?: unknown;
      expiresAt?: number;
      sub?: string;
    };
  } catch {
    return null;
  }
}

/* ---------- Cognito JWT 検証 ---------- */

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg: string;
}

interface JwksCache {
  keys: JwksKey[];
  expiry: number;
}

let jwksCache: JwksCache | null = null;

async function getSigningKey(kid: string): Promise<JwksKey | undefined> {
  const now = Date.now();
  if (jwksCache && now < jwksCache.expiry) {
    return jwksCache.keys.find((k) => k.kid === kid);
  }
  const res = await fetch(COGNITO_JWKS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`cognito jwks fetch failed: ${res.status}`);
  const jwks = (await res.json()) as { keys: JwksKey[] };
  jwksCache = {
    keys: jwks.keys || [],
    expiry: now + 24 * 60 * 60 * 1000,
  };
  return jwksCache.keys.find((k) => k.kid === kid);
}

/*
 * Cognito アクセストークン (JWT, RS256) の署名・発行者・対象クライアント・有効期限を検証.
 */
async function verifyCognitoAccessToken(accessToken: string): Promise<Record<string, unknown>> {
  const parts = accessToken.split('.');
  if (parts.length !== 3) throw new Error('malformed access_token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
    alg: string;
    kid: string;
    typ?: string;
  };
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

  const key = await getSigningKey(header.kid);
  if (!key) throw new Error('signing key not found');

  const keyObj = crypto.createPublicKey({
    key: {
      kty: key.kty,
      kid: key.kid,
      n: key.n,
      e: key.e,
      alg: key.alg,
    },
    format: 'jwk',
  } as crypto.JsonWebKeyInput);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const sig = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('RSA-SHA256', data, keyObj, sig)) {
    throw new Error('invalid signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== COGNITO_ISSUER) {
    throw new Error('invalid issuer');
  }
  const aud = payload.aud || payload.client_id;
  if (aud !== COGNITO_CLIENT_ID) {
    throw new Error('invalid audience');
  }
  if (payload.token_use !== 'access') {
    throw new Error('not an access token');
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('access_token expired');
  }
  return payload;
}

/* ---------- ユーティリティ ---------- */

function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  if (headers && headers[lower] !== undefined) {
    const v = headers[lower];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  }
  if (headers) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) {
        const v = headers[k];
        return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
      }
    }
  }
  return undefined;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of String(cookieHeader).split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function corsHeaders(origin: string): Record<string, string> {
  const allow = FRONTEND_URL || origin || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

const COMMON_COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=/${
  COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : ''
}`;

function getUserId(session: { sub?: string; user?: unknown } | null): string | null {
  if (!session) return null;
  return session.sub ?? null;
}

/* ---------- TODO CRUD (DynamoDB) ---------- */

interface TodoItem {
  userId: string;
  todoId: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

function extractTodoId(path: string): string | undefined {
  const match = path.match(/^\/api\/todos\/([^/]+)$/);
  return match ? match[1] : undefined;
}

function todoResponse(todo: TodoItem | null, cors: Record<string, string>): Response {
  if (!todo) {
    return {
      statusCode: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'todo not found' }),
    };
  }
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(todo),
  };
}

async function handleListTodos(userId: string, cors: Record<string, string>): Promise<Response> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TODOS_TABLE_NAME,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false, // 新しい順
    }),
  );
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ todos: (result.Items ?? []) as TodoItem[] }),
  };
}

async function handleCreateTodo(
  userId: string,
  body: string,
  cors: Record<string, string>,
): Promise<Response> {
  let payload: { title?: string };
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'invalid JSON body' }),
    };
  }
  const title = String(payload.title || '').trim();
  if (!title) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'title is required' }),
    };
  }
  const now = new Date().toISOString();
  const todoId = crypto.randomUUID();
  const todo: TodoItem = {
    userId,
    todoId,
    title,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TODOS_TABLE_NAME, Item: todo }));
  return {
    statusCode: 201,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(todo),
  };
}

async function handleGetTodo(
  userId: string,
  todoId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const result = await docClient.send(
    new GetCommand({ TableName: TODOS_TABLE_NAME, Key: { userId, todoId } }),
  );
  return todoResponse((result.Item as TodoItem | undefined) ?? null, cors);
}

async function handleUpdateTodo(
  userId: string,
  todoId: string,
  body: string,
  cors: Record<string, string>,
): Promise<Response> {
  let payload: { title?: string; completed?: boolean };
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'invalid JSON body' }),
    };
  }

  const updateParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};

  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (!title) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'title cannot be empty' }),
      };
    }
    updateParts.push('#title = :t');
    exprNames['#title'] = 'title';
    exprValues[':t'] = title;
  }
  if (payload.completed !== undefined) {
    updateParts.push('completed = :c');
    exprValues[':c'] = payload.completed === true;
  }

  if (updateParts.length === 0) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'no fields to update' }),
    };
  }

  updateParts.push('updatedAt = :u');
  exprValues[':u'] = new Date().toISOString();

  // ReturnValues: 'ALL_NEW' で更新後の項目が返るため、追加の get は不要
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TODOS_TABLE_NAME,
      Key: { userId, todoId },
      UpdateExpression: 'set ' + updateParts.join(', '),
      ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return todoResponse((result.Attributes as TodoItem | undefined) ?? null, cors);
}

async function handleDeleteTodo(
  userId: string,
  todoId: string,
  cors: Record<string, string>,
): Promise<Response> {
  await docClient.send(new DeleteCommand({ TableName: TODOS_TABLE_NAME, Key: { userId, todoId } }));
  return {
    statusCode: 204,
    headers: cors,
    body: '',
  };
}

/* ---------- 認証エンドポイント ---------- */

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
}

interface ApiGatewayV2Event {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: string[];
  queryStringParameters?: Record<string, string> | null;
  requestContext?: {
    http?: { method?: string };
  };
  isBase64Encoded?: boolean;
  body?: string | null;
}

function handleLogin(cors: Record<string, string>): {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
} {
  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Cognito is not configured' }),
    };
  }
  const redirectUri = `${FRONTEND_URL || ''}/auth/callback`;
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
  });
  const location = `${COGNITO_LOGIN_URL}?${params}`;
  return {
    statusCode: 302,
    headers: { ...cors, Location: location },
    body: '',
  };
}

async function handleCallback(
  query: Record<string, string>,
  cors: Record<string, string>,
): Promise<Response> {
  if (query.error) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({
        error: 'auth_error',
        error_description: query.error_description || query.error,
      }),
    };
  }
  const code = query.code;
  if (!code) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'missing code' }),
    };
  }

  const redirectUri = `${FRONTEND_URL || ''}/auth/callback`;

  // Cognito トークンエンドポイントで認可コードをアクセストークンに交換
  const res = await fetch(COGNITO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: COGNITO_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'token exchange failed', detail: text }),
    };
  }
  const tokens = JSON.parse(text) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokens.access_token) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'no access token returned' }),
    };
  }

  // アクセストークン (JWT) を検証し、ユーザーID (sub) を取得
  let payload: Record<string, unknown>;
  try {
    payload = await verifyCognitoAccessToken(tokens.access_token);
  } catch (err) {
    return {
      statusCode: 401,
      headers: cors,
      body: JSON.stringify({
        error: 'invalid access token',
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  const sub = String(payload.sub ?? '');
  const email = String(payload.email ?? '');
  const expiresIn = tokens.expires_in ? Number(tokens.expires_in) * 1000 : 3600 * 1000;

  const sessionPayload = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    user: { sub, email },
    sub,
    expiresAt: Date.now() + expiresIn,
  };
  const sessionValue = sealSession(sessionPayload);
  const redirectTo = FRONTEND_URL || '/';

  return {
    statusCode: 302,
    headers: { ...cors, Location: redirectTo },
    cookies: [`${COOKIE_NAME}=${sessionValue}; ${COMMON_COOKIE_ATTRS}`],
    body: '',
  };
}

function handleLogout(cors: Record<string, string>): {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
} {
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    logout_uri: FRONTEND_URL || '/',
  });
  const location = `${COGNITO_LOGOUT_URL}?${params}`;
  return {
    statusCode: 302,
    headers: { ...cors, Location: location },
    cookies: [`${COOKIE_NAME}=; ${COMMON_COOKIE_ATTRS}; Max-Age=0`],
    body: '',
  };
}

function handleMe(
  session: { sub?: string; user?: unknown; expiresAt?: number } | null,
  cors: Record<string, string>,
): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  if (!session || !session.sub) {
    return {
      statusCode: 401,
      headers: cors,
      body: JSON.stringify({ authenticated: false }),
    };
  }
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authenticated: true,
      user: session.user,
      sub: session.sub,
      expiresAt: session.expiresAt,
    }),
  };
}

/* ---------- 外部 API プロキシ ---------- */

async function handleApi(
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  query: Record<string, string> | undefined,
  body: string,
  session: { accessToken?: string } | null,
  cors: Record<string, string>,
  rawQueryString: string,
): Promise<Response> {
  const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || '';
  if (!session || !session.accessToken) {
    return {
      statusCode: 401,
      headers: cors,
      body: JSON.stringify({ authenticated: false, error: 'unauthenticated' }),
    };
  }
  if (!BACKEND_BASE_URL) {
    return {
      statusCode: 404,
      headers: cors,
      body: JSON.stringify({ error: 'not found' }),
    };
  }
  const targetPath = path.replace(/^\/api/, '') || '/';
  const qs = rawQueryString ? `?${rawQueryString}` : '';
  const targetUrl = `${BACKEND_BASE_URL.replace(/\/$/, '')}${targetPath}${qs}`;

  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'connection' ||
      lk === 'transfer-encoding' ||
      lk === 'x-amzn-trace-id'
    ) {
      continue;
    }
    if (v !== undefined) {
      fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
  }
  fwdHeaders['Authorization'] = `Bearer ${session.accessToken}`;

  const res = await fetch(targetUrl, {
    method,
    headers: fwdHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: 'manual',
  });

  const respBody = await res.text();
  const outHeaders: Record<string, string> = { ...cors };
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'transfer-encoding' || lk === 'set-cookie') {
      return;
    }
    outHeaders[k] = v;
  });
  return { statusCode: res.status, headers: outHeaders, body: respBody };
}

/* メインハンドラ */
export const handler = async (event: ApiGatewayV2Event): Promise<Response> => {
  await ensureSecretsLoaded();

  const headers = event.headers || {};

  const requestContext = event.requestContext || {};
  const http = requestContext.http || {};
  const method = http.method || 'GET';
  const rawPath = event.rawPath || '/';
  const path = rawPath.split('?')[0];
  const query = event.queryStringParameters || {};
  const rawQueryString = event.rawQueryString || '';
  const cookieHeader =
    getHeader(headers, 'cookie') || (event.cookies ? event.cookies.join('; ') : '');
  const cookies = parseCookies(cookieHeader);
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  const origin = getHeader(headers, 'origin') || '';
  const cors = corsHeaders(origin);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  const sessionCookie = cookies[COOKIE_NAME];
  const session = sessionCookie ? openSession(sessionCookie) : null;

  try {
    if (path === '/auth/login' && method === 'GET') {
      return handleLogin(cors);
    }
    if (path === '/auth/callback' && method === 'GET') {
      return await handleCallback(query, cors);
    }
    if (path === '/auth/logout' && method === 'GET') {
      return handleLogout(cors);
    }
    if (path === '/auth/me' && method === 'GET') {
      return handleMe(session, cors);
    }

    // TODO CRUD (セッション必須)
    if (path.startsWith('/api/todos')) {
      const userId = getUserId(session);
      if (!userId) {
        return {
          statusCode: 401,
          headers: cors,
          body: JSON.stringify({ authenticated: false, error: 'unauthenticated' }),
        };
      }
      const todoId = extractTodoId(path);

      if (path === '/api/todos' && method === 'GET') {
        return await handleListTodos(userId, cors);
      }
      if (path === '/api/todos' && method === 'POST') {
        return await handleCreateTodo(userId, body, cors);
      }
      if (todoId && method === 'GET') {
        return await handleGetTodo(userId, todoId, cors);
      }
      if (todoId && method === 'PUT') {
        return await handleUpdateTodo(userId, todoId, body, cors);
      }
      if (todoId && method === 'DELETE') {
        return await handleDeleteTodo(userId, todoId, cors);
      }
      return {
        statusCode: 404,
        headers: cors,
        body: JSON.stringify({ error: 'not found' }),
      };
    }

    if (path.startsWith('/api/')) {
      return await handleApi(path, method, headers, query, body, session, cors, rawQueryString);
    }

    return {
      statusCode: 404,
      headers: cors,
      body: JSON.stringify({ error: 'not found' }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({
        error: 'internal error',
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};

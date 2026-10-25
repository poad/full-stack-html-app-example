# Cognito BFF — デプロイ手順

本ドキュメントは、Amazon CloudFront + AWS Lambda Function URL + AWS Lambda (Node.js 22, TypeScript) + Amazon Cognito で構成される
認証付き BFF を AWS CDK でデプロイする手順です。

## 構成

```plaintext
CloudFront (HTTPS, OAC sigv4, セキュリティヘッダ)
  └─ AWS Lambda Function URL (AWS_IAM 認証)
       └─ AWS Lambda (Node.js 22, TypeScript, esbuild バンドル)
            ├─ Amazon Cognito ユーザープール (メールサインイン, MFA, パスキー対応)
            ├─ SSM Parameter Store (SecureString): BFF セッション暗号化鍵
            └─ DynamoDB (TODOリスト)
```

API Gateway は使用しません。CloudFront のオリジンとして Lambda Function URL を直接指定し、
Origin Access Control (OAC, SigV4) により CloudFront からのみ Lambda を呼び出せるように制限します。

Lambda は AWS SDK v2 (Lambda ランタイムプリインストール) を DynamoDB / SSM 読み取りに使用し、
Cognito アクセストークン (JWT, RS256/JWKS) の検証とセッション Cookie の暗号化・署名は Node.js 組み込み
(`crypto` / `fetch`) のみで行います。

## 認証について

- **ユーザーストア**: Amazon Cognito ユーザープール (メールアドレスでサインイン)
- **MFA**: OTP (TOTP) をオプションでサポート (`mfa: OPTIONAL`)
- **パスキー (WebAuthn)**: Cognito ユーザープールでパスキー認証を有効にすると、Cognito ホスト型UI からパスキーによるログインが可能です。
  CDK v2 ではパスキーの直接有効化が限定的なため、デプロイ後 Cognito コンソールの
  [ユーザープール > ログイン > パスキー] から有効化してください。

## エンドポイント

| メソッド | パス | 説明 |
| -------- | ---- | ---- |
| GET | `/auth/login` | Cognito ホスト型UI (ログイン/サインアップ/パスキー/MFA) へリダイレクト |
| GET | `/auth/callback` | Cognito 認可コード → トークン交換、セッション Cookie 発行 |
| GET | `/auth/logout` | セッション削除 + Cognito サインアウト |
| GET | `/auth/me` | セッション検証とユーザ情報返却 |
| GET | `/api/todos` | ユーザーのTODO一覧を取得 |
| POST | `/api/todos` | TODOを作成 |
| GET | `/api/todos/{todoId}` | 特定のTODOを取得 |
| PUT | `/api/todos/{todoId}` | TODOを更新 (title, completed) |
| DELETE | `/api/todos/{todoId}` | TODOを削除 |
| \* | `/api/*` | セッション付きアクセストークンでバックエンドをプロキシ |

## 前提条件

1. **AWS 認証**: `aws sts get-caller-identity` が成功すること
2. **CDK ブートストラップ**: `npx cdk bootstrap` が済んでいること

## 1. 環境変数ファイルの作成

```bash
cp .env.example .env
# .env を編集して SESSION_SECRET, FRONTEND_URL などを設定
SESSION_SECRET=$(openssl rand -base64 32)
FRONTEND_URL=https://<フロントエンドのURL>
```

## 2. 初回デプロイ

```bash
./deploy.sh
```

デプロイ後、以下の出力を確認します:

- **CloudFrontDomainName**: API エンドポイント (フロントエンドの `PUBLIC_API_URL` に設定)
- **UserPoolId**: Cognito ユーザープール ID
- **UserPoolClientId**: Cognito クライアント ID (フロントエンドの `PUBLIC_COGNITO_CLIENT_ID` に設定)
- **UserPoolDomain**: Cognito ホスト型UI の URL (フロントエンドの `PUBLIC_COGNITO_DOMAIN` に設定)

## 3. Cognito でパスキーを有効化 (オプション)

Cognito コンソール > ユーザープール > [ログイン] > [パスキー] から「パスキー認証」を有効にします。
これにより、Cognito ホスト型UI からパスキー (WebAuthn) によるログイン・登録が利用可能になります。

## 4. 動作確認

```bash
# ログイン開始 (ブラウザで Cognito ホスト型UI を開く)
curl -I https://<cloudfront-domain>/auth/login

# セッション確認
curl -b cookies.txt https://<cloudfront-domain>/auth/me

# TODO 一覧取得
curl -b cookies.txt https://<cloudfront-domain>/api/todos

# TODO 作成
curl -b cookies.txt -X POST https://<cloudfront-domain>/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"買い物"}'
```

## フロントエンド (Astro) との連携

バックエンドデプロイ後、以下をフロントエンドの `.env` に設定します。

```bash
# frontend ディレクトリで
cp .env.example .env

# .env に以下を設定
PUBLIC_API_URL=https://<cloudfront-domain-name>
PUBLIC_COGNITO_DOMAIN=https://<cognito-userpool-domain>.auth.<region>.amazoncognito.com
PUBLIC_COGNITO_CLIENT_ID=<cognito-user-pool-client-id>

pnpm build
```

CORS でクッキー (セッション) を送信するには、バックエンドスタックに `FRONTEND_URL` を設定してデプロイする必要があります:

```bash
# backend/.env に追加
FRONTEND_URL=https://<frontend-domain>

./deploy.sh
```

## コマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `pnpm build` | TypeScript 型チェック |
| `npx cdk synth` | CloudFormation テンプレート出力 |
| `npx cdk diff` | デプロイ差分確認 |
| `npx cdk deploy` | スタックデプロイ |
| `./deploy.sh` | 環境変数ファイル読み込み付きデプロイ (SSM へのシークレット書き込み含む) |
| `npx cdk destroy` | スタック削除 |

## セキュリティ注意点

- `SESSION_SECRET` は SSM Parameter Store (SecureString, KMS 暗号化) に保存され、Lambda 実行時にのみ取得されます
- Lambda 実行ロールに `ssm:GetParameter` (復号) 権限および DynamoDB 読み書き権限を付与
- セッション Cookie は `HttpOnly; Secure; SameSite=Lax` 属性で発行されます
- CloudFront → Lambda 間は Origin Access Control (OAC, SigV4) で保護され、Lambda Function URL は AWS_IAM 認証です (CloudFront 以外からの直接呼び出しは拒否)
- CloudFront エッジで HSTS, X-Frame-Options, CSP 等のセキュリティヘッダを付与

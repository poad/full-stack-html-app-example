# 全スタック HTML アプリ例 (Astro + AWS CDK + Cognito + DynamoDB)

Astro (フロントエンド) から AWS Lambda (BFF) を経由して DynamoDB に CRUD し、TODOリストを作成する全スタックサンプルです。

認証は **Amazon Cognito** (ユーザープール) を使用し、メールサインイン・MFA・パスキー (WebAuthn) に対応しています。

## 構成図

```
ブラウザ (Astro 静的サイト)
      │ HTTPS / Cookie (セッション)
      ▼
Amazon CloudFront (OAC / SigV4)
      │
      ▼
AWS Lambda Function URL (AWS_IAM 認証)
      │ Node.js 22 + TypeScript
      ▼
+-----------------------------+
| BFF Lambda                  |
| - セッション Cookie (暗号化+署名)   |
| - Cognito アクセストークン検証 (JWT) |
| - TODO CRUD (DynamoDB)          |
+-----------------------------+
      │
      ▼
Amazon DynamoDB (TODO テーブル: userId / todoId)

認証:
Amazon Cognito ユーザープール (ホスト型UI)
- メールアドレスでサインイン
- MFA (OTP/TOTP) オプション対応
- パスキー (WebAuthn) 対応 (コンソールで有効化)
```

## ディレクトリ構成

```
.
├── backend/              # AWS CDK + Lambda (BFF)
│   ├── bin/backend.ts               # CDK エントリーポイント
│   ├── lib/backend-stack.ts         # CDK スタック定義
│   ├── lambda/cognito-bff/index.ts  # BFF Lambda ハンドラ
│   ├── deploy.sh                    # デプロイスクリプト
│   ├── DEPLOYMENT.md                # デプロイ手順 (詳細)
│   ├── .env.example                 # 環境変数例
│   ├── package.json
│   ├── cdk.json
│   └── tsconfig.json
├── frontend/              # Astro フロントエンド (静的出力)
│   ├── src/pages/index.astro        # TODOリスト画面
│   ├── .env.example                 # 環境変数例
│   ├── package.json
│   ├── astro.config.mjs
│   └── tsconfig.json
├── deploy-role/           # デプロイ用 IAM ロール (CDK ブートストラップ用)
├── pnpm-workspace.yaml
├── package.json
└── README.md              # 本ファイル
```

## エンドポイント

| メソッド | パス | 説明 |
|--------|------|------|
| GET | `/auth/login` | Cognito ホスト型UI へリダイレクト (ログイン/サインアップ/パスキー/MFA) |
| GET | `/auth/callback` | Cognito 認可コード → トークン交換、セッション Cookie 発行 |
| GET | `/auth/logout` | セッション削除 + Cognito サインアウト |
| GET | `/auth/me` | セッション検証とユーザー情報返却 |
| GET | `/api/todos` | ユーザーのTODO一覧取得 |
| POST | `/api/todos` | TODO作成 |
| GET | `/api/todos/{todoId}` | 特定のTODO取得 |
| PUT | `/api/todos/{todoId}` | TODO更新 (title, completed) |
| DELETE | `/api/todos/{todoId}` | TODO削除 |

## 認証の仕組み

1. **ログイン**: フロントエンドの「ログイン」ボタンを押すと Cognito ホスト型UI へリダイレクトされます。
2. **サインイン/サインアップ**: Cognito ホスト型UI でメールアドレスとパスワードを入力します。パスキー (WebAuthn) が有効になっている場合はパスキーでもログイン可能です。
3. **MFA**: Cognito ユーザープールで MFA を有効にすると、OTP (TOTP) による多要素認証が利用できます。
4. **コールバック**: 認可コードを Cognito トークンエンドポイントでアクセストークンに交換し、暗号化・署名済みのセッション Cookie (`bff_session`) を発行します。
5. **API 呼び出し**: フロントエンドは `credentials: 'include'` でセッション Cookie を送信し、Lambda は Cookie を復号してユーザーを特定し、DynamoDB からユーザー固有のTODOを操作します。

セッション Cookie は `HttpOnly; Secure; SameSite=Lax` 属性で発行され、XSS / CSRF 対策が施されています。

## 前提条件

- AWS CLI で認証済み (`aws sts get-caller-identity` が成功すること)
- CDK ブートストラップ済み (`npx cdk bootstrap`)
- Node.js / pnpm がインストール済み

## セットアップとデプロイ

### 1. バックエンド (AWS) をデプロイ

```bash
cd backend

# 環境変数ファイルを作成
cp .env.example .env

# .env を編集 (SESSION_SECRET は 32バイト以上のランダム文字列を推奨)
SESSION_SECRET=$(openssl rand -base64 32)
FRONTEND_URL=https://<フロントエンドをホストするURL>

# デプロイ
./deploy.sh
```

デプロイ後、以下の出力を確認します:

- `CloudFrontDomainName`: API エンドポイント (フロントエンドの `PUBLIC_API_URL` に設定)
- `UserPoolId`: Cognito ユーザープール ID
- `UserPoolClientId`: Cognito クライアント ID (フロントエンドの `PUBLIC_COGNITO_CLIENT_ID` に設定)
- `UserPoolDomain`: Cognito ホスト型UI の URL (フロントエンドの `PUBLIC_COGNITO_DOMAIN` に設定)

### 2. Cognito でパスキー (WebAuthn) を有効化 (オプション)

Cognito コンソール > ユーザープール > [ログイン] > [パスキー] から「パスキー認証」を有効にします。これにより、パスキーによるログイン・登録が利用可能になります。

### 3. フロントエンド (Astro) をビルド

```bash
cd frontend

# 環境変数ファイルを作成
cp .env.example .env

# .env を編集
PUBLIC_API_URL=https://<CloudFrontドメイン名>
PUBLIC_COGNITO_DOMAIN=https://<Cognitoユーザープールドメイン>.auth.<リージョン>.amazoncognito.com
PUBLIC_COGNITO_CLIENT_ID=<CognitoユーザープールクライアントID>

# 依存関係インストールとビルド
pnpm install
pnpm build
```

ビルド成果物は `frontend/dist/` に出力されます (静的サイトホスティングにデプロイ可能です)。

## 開発コマンド

### バックエンド

| コマンド | 説明 |
|---------|------|
| `pnpm build` | TypeScript 型チェック |
| `npx cdk synth` | CloudFormation テンプレート出力 |
| `npx cdk diff` | デプロイ差分確認 |
| `npx cdk deploy` | スタックデプロイ |
| `./deploy.sh` | 環境変数ファイル読み込み付きデプロイ |
| `npx cdk destroy` | スタック削除 |

### フロントエンド

| コマンド | 説明 |
|---------|------|
| `pnpm dev` | 開発サーバー起動 (`astro dev --background` 推奨) |
| `pnpm build` | 静的サイトビルド |
| `pnpm preview` | ビルド成果物をプレビュー |
| `pnpm lint` | リンタチェック |

### モノレポ (ルート)

| コマンド | 説明 |
|---------|------|
| `pnpm build` | 全パッケージをビルド |
| `pnpm lint` | 全パッケージをリンタチェック |

## セキュリティ注意点

- `SESSION_SECRET` は SSM Parameter Store (SecureString, KMS 暗号化) に保存され、Lambda 実行時にのみ取得されます
- Lambda 実行ロールに `ssm:GetParameter` (復号) と DynamoDB 読み書き権限を付与 (最小権限)
- セッション Cookie は `HttpOnly; Secure; SameSite=Lax` 属性で発行
- CloudFront → Lambda 間は Origin Access Control (OAC, SigV4) で保護し、Lambda Function URL は AWS_IAM 認証
- CloudFront エッジで HSTS, X-Frame-Options, CSP 等のセキュリティヘッダを付与

## 注意事項

- パスキー (WebAuthn) は CDK v2 での直接サポートが限定的なため、デプロイ後に Cognito コンソールで個別に有効化する必要があります。
- Cognito ユーザープールドメインのプレフィックスは AWS 全体で一意である必要があり、衝突した場合はデプロイエラーになります。
- フロントエンドは静的サイト (`output: 'static'`) としてビルドされます。ホスティングは Amazon S3 + CloudFront、Amplify Hosting などをご検討ください。

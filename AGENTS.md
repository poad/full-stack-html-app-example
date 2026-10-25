# リポジトリ共通注意事項 (日本語)

## 構成 (pnpm モノレポ)

```plaintext
backend/   - AWS CDK + Lambda (BFF, Node.js 22, Cognito + DynamoDB)
frontend/  - Astro 静的サイト (output: 'static')
deploy-role- CDK ブートストラップ用 IAM ロール
```

`pnpm-workspace.yaml` で 3 パッケージを管理。ルートの `pnpm build` / `pnpm lint` / `pnpm lint-fix` は全パッケージに横断実行される (`pnpm -r --if-present`)。

## 必須環境

- パッケージマネージャ: **pnpm@12.17.0** (`devEngines` で指定、未インストール時は自動ダウンロード)
- Node.js: **^26.13.0**
- TypeScript: **~7.0.2** (backend/frontend ともにこのバージョン)
- フォーマッタ/リンタ: **oxfmt / oxlint** (prettier / eslint ではない)

## 開発コマンド

| 対象 | コマンド | 説明 |
| --- | ------- | --- |
| ルート | `pnpm build` | 全パッケージの build |
| ルート | `pnpm lint` | 全パッケージの lint |
| ルート | `pnpm lint-fix` | 全パッケージの lint-fix |
| backend | `pnpm build` (= `tsc`) | TypeScript 型チェックのみ (出力なし) |
| backend | `npx cdk synth` | CloudFormation テンプレート出力 |
| backend | `npx cdk deploy BackendStack` | スタックデプロイ |
| backend | `./deploy.sh` | `.env` 読み込み + SSM 書き込み + cdk deploy |
| frontend | `astro dev --background` | 開発サーバー (バックグラウンド) |
| frontend | `astro build` | 静的ビルド (`dist/`) |
| frontend | `astro check` | 型チェック |

**backend は `build` だけではデプロイされない。** `tsc` は型チェックのみ。実際のインフラ変更は `npx cdk deploy` または `./deploy.sh` が必要。

## 環境変数 (重要)

**backend** (`backend/.env`):

- `SESSION_SECRET` — **必須**。`./deploy.sh` はこれが空だと終了エラーになる。例: `SESSION_SECRET=$(openssl rand -base64 32)`
- `FRONTEND_URL` — 任意。CORS 許可オリジンとコールバック URL に使用

**frontend** (`frontend/.env`):

- Astro はビルド時に `import.meta.env.PUBLIC_*` のみをクライアントに埋め込む。必ず `PUBLIC_` プレフィックスを付ける:
  - `PUBLIC_API_URL` — CloudFront ドメイン (例: `https://d123.cloudfront.net`)
  - `PUBLIC_COGNITO_DOMAIN` — Cognito ホスト型UI URL
  - `PUBLIC_COGNITO_CLIENT_ID` — Cognito クライアント ID

## デプロイフロー (backend)

1. `backend/.env` を作成 (`cp .env.example .env`)、`SESSION_SECRET` を設定
2. `AWS CLI` で認証済みであること (`aws sts get-caller-identity`)
3. `./deploy.sh` (SSM へセッション鍵を書き込み、CDK デプロイ。初回は `cdk bootstrap` も自動実行)
4. `npx cdk outputs BackendStack` で `CloudFrontDomainName` / `UserPoolId` / `UserPoolClientId` / `UserPoolDomain` を取得
5. Cognito コンソールで [ユーザープール > ログイン > パスキー] を**手動で有効化** (CDK ではパスキーを直接有効化できない)
6. フロントエンドの `.env` に `PUBLIC_API_URL` / `PUBLIC_COGNITO_DOMAIN` / `PUBLIC_COGNITO_CLIENT_ID` を設定し `pnpm build`

## アーキテクチャの注意点

- **Lambda のエントリ**: `backend/lambda/cognito-bff/index.ts` (`handler` エクスポート)
- **AWS SDK v2 は Lambda ランタイムプリインストール**のため、`externalModules: ['aws-sdk']` でバンドルから除外。SDK v3 を追加しないこと。
- **Cognito ユーザープールドメイン**は `backend-stack.ts` 内で同じ construct ID `UserPoolDomain` が 2 回定義されている (98 行目と 117 行目)。CDK 合成 (`cdk synth`) で重複エラーになる可能性があるため、ドメイン周りを変更する際は両方を確認すること。
- DynamoDB テーブル: パーティションキー `userId` / ソートキー `todoId`。ユーザーごとに TODO を分離。
- CloudFront → Lambda は Origin Access Control (SigV4) + Lambda Function URL は AWS_IAM 認証。CloudFront 以外からの直接呼び出しは拒否される。

## テスト

- backend: `pnpm test` (= `vitest run`)
- frontend: 専用のテストスクリプトは `package.json` にない

## 既存の instruction ファイル

- `frontend/AGENTS.md` — Astro 開発サーバーは必ず `--background` で起動し、`astro dev stop / status / logs` で管理すること
- CI ワークフロー (`.github/workflows/*`) は存在しない

#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------
# Cognito BFF スタックのデプロイスクリプト (CloudFront + Lambda Function URL + Cognito + SSM)
# ---------------------------------------------------------------
# 使い方:
#   ./deploy.sh                      # スタックの初回デプロイ（または差分デプロイ）
#
# 事前準備:
#   1. AWS CLI で認証済みであること (aws sts get-caller-identity)
#   2. CDK ブートストラップ済みであること (cdk bootstrap)
#   3. Cognito ユーザープールは CDK で自動作成されます。
#      パスキー (WebAuthn) は Cognito コンソールの
#      [ユーザープール > ログイン > パスキー] から有効化してください。
# ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

# 必須環境変数のチェック
missing=0
for var in SESSION_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: 環境変数 $var が設定されていません (.env ファイルを確認してください)"
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# SSM Parameter Store (SecureString) にセッション鍵を書き込む
SESSION_SECRET_PARAM="/FullStackHtmlAppExampleBackend/bff-session-secret"

echo "=== SSM Parameter Store にセッション鍵を書き込み中 ==="
if ! aws ssm get-parameter --name "$SESSION_SECRET_PARAM" --region "$REGION" --with-decryption >/dev/null 2>&1; then
  aws ssm put-parameter \
    --name "$SESSION_SECRET_PARAM" \
    --value "$SESSION_SECRET" \
    --type SecureString \
    --region "$REGION" \
    --overwrite >/dev/null
  echo "  created: $SESSION_SECRET_PARAM"
else
  aws ssm put-parameter \
    --name "$SESSION_SECRET_PARAM" \
    --value "$SESSION_SECRET" \
    --type SecureString \
    --region "$REGION" \
    --overwrite >/dev/null
  echo "  updated: $SESSION_SECRET_PARAM"
fi

# CDK コンテキストの構築
CONTEXT_ARGS=(
  -c sessionSecretParamName="$SESSION_SECRET_PARAM"
)

if [[ -n "${FRONTEND_URL:-}" ]]; then
  CONTEXT_ARGS+=(-c frontendUrl="$FRONTEND_URL")
fi

# CDK ブートストラップ確認
if ! aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "$REGION" >/dev/null 2>&1; then
  echo "CDK ブートストラップが見つかりません。ブートストラップを実行します..."
  pnx cdk bootstrap
fi

# スタックのデプロイ
echo ""
echo "=== CDK デプロイを開始 ==="
pnx cdk deploy "${CONTEXT_ARGS[@]}" --require-approval never "$@"

# CloudFront ドメイン名を取得してフロントエンドの PUBLIC_API_URL を自動設定
echo ""
echo "=== CloudFront ドメイン名を取得中 ==="
CLOUDFRONT_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name FullStackHtmlAppExampleBackend \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomainName'].OutputValue" \
  --output text 2>/dev/null)

COGNITO_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name FullStackHtmlAppExampleBackend \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolDomainOutput'].OutputValue" \
  --output text 2>/dev/null)

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name FullStackHtmlAppExampleBackend \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text 2>/dev/null)

ASSETS_BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name FullStackHtmlAppExampleBackend \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketName'].OutputValue" \
  --output text 2>/dev/null)

# フロントエンド .env に CloudFront ドメイン名と Cognito 情報を自動設定
echo ""
echo "=== フロントエンド環境変数を設定中 ==="
FRONTEND_ENV_FILE="../frontend/.env"
set_env_value() {
  local key="$1"
  local value="$2"
  local masking="$3"
  if [[ -z "${value}" ]]; then
    echo "  スキップ: ${key} (値が空です)"
    return
  fi
  if [[ -f "$FRONTEND_ENV_FILE" ]] && grep -q "^${key}=" "$FRONTEND_ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$FRONTEND_ENV_FILE"
    if [ "${masking}" = "true" ]; then
      echo "  updated: ${key}=****"
    else
      echo "  updated: ${key}=${value}"
    fi
  else
    echo "${key}=${value}" >> "$FRONTEND_ENV_FILE"
    if [ "${masking}" = "true" ]; then
      echo "  created: ${key}=****"
    else
      echo "  created: ${key}=${value}"
    fi
  fi
}

set_env_value "PUBLIC_API_URL" "https://${CLOUDFRONT_DOMAIN}" "true"
set_env_value "PUBLIC_COGNITO_DOMAIN" "${COGNITO_DOMAIN}" "true"
set_env_value "PUBLIC_COGNITO_CLIENT_ID" "${COGNITO_CLIENT_ID}" "true"

# フロントエンドビルド (Astro)
if [[ -n "${CLOUDFRONT_DOMAIN}" ]]; then
  echo ""
  echo "=== フロントエンドビルド (Astro) ==="
  (
    cd ../frontend
    pnpm install
    pnpm build
  )
fi

if [[ -n "${ASSETS_BUCKET_NAME}" ]]; then
  echo ""
  echo "=== フロントエンドアップロード ==="
  (
    cd ../frontend/dist
    aws s3 sync . "s3://${ASSETS_BUCKET_NAME}"
  )  
fi

echo ""
echo "=== デプロイ完了 ==="
echo "CloudFront ドメイン名: https://${CLOUDFRONT_DOMAIN:-取得失敗}"
echo "Cognito ユーザープール情報は 'pnx cdk outputs FullStackHtmlAppExampleBackend' で確認できます。"
echo ""
echo "パスキー (WebAuthn) を有効にするには、Cognito コンソールの"
echo "[ユーザープール > ログイン > パスキー] から有効化してください。"

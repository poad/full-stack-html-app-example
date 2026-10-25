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
STACK_NAME="${STACK_NAME:-BackendStack}"

# SSM Parameter Store (SecureString) にセッション鍵を書き込む
SESSION_SECRET_PARAM="/${STACK_NAME}/bff-session-secret"

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
  npx cdk bootstrap
fi

# スタックのデプロイ
echo ""
echo "=== CDK デプロイを開始 ==="
npx cdk deploy "BackendStack" "${CONTEXT_ARGS[@]}" --require-approval never "$@"

echo ""
echo "=== デプロイ完了 ==="
echo "CloudFront ドメイン名、Cognito ユーザープール情報は 'npx cdk deploy' 出力 または 'npx cdk outputs BackendStack' で確認できます。"
echo ""
echo "Cognito ホスト型UI の URL は 'UserPoolDomain' 出力から確認し、"
echo "フロントエンドの PUBLIC_COGNITO_DOMAIN / PUBLIC_COGNITO_CLIENT_ID に設定してください。"
echo ""
echo "パスキー (WebAuthn) を有効にするには、Cognito コンソールの"
echo "[ユーザープール > ログイン > パスキー] から有効化してください。"
